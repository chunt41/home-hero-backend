import type { Request, Response } from "express";
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  DEFAULT_TIMEZONE,
  normalizePreference,
} from "../services/notificationPreferences";
import { logger } from "../services/logger";

type AuthUser = {
  userId: number;
};

type AuthRequest = Request & { user?: AuthUser };

function isMissingTableOrRelationError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "");
  return (/relation/i.test(msg) || /table/i.test(msg)) && /does not exist/i.test(msg);
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

const hhmm = z
  .string()
  .trim()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM (00:00-23:59)");

const updateSchema = z
  .object({
    jobMatchEnabled: z.boolean().optional(),
    // New API fields
    matchDeliveryMode: z.enum(["INSTANT", "DIGEST"]).optional(),
    digestIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),

    // Legacy fields (backward compat)
    jobMatchDigestEnabled: z.boolean().optional(),
    jobMatchDigestIntervalMinutes: z.number().int().min(5).max(1440).optional(),
    bidEnabled: z.boolean().optional(),
    messageEnabled: z.boolean().optional(),

    // Treat null as "clear".
    quietHoursStart: hhmm.nullable().optional(),
    quietHoursEnd: hhmm.nullable().optional(),

    timezone: z.string().trim().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const hasStart = Object.prototype.hasOwnProperty.call(val, "quietHoursStart");
    const hasEnd = Object.prototype.hasOwnProperty.call(val, "quietHoursEnd");

    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quietHoursStart"],
        message: "quietHoursStart and quietHoursEnd must be set together",
      });
      return;
    }

    if (hasStart && hasEnd) {
      const start = val.quietHoursStart;
      const end = val.quietHoursEnd;
      const bothNull = start == null && end == null;
      const bothStrings = typeof start === "string" && typeof end === "string";
      if (!bothNull && !bothStrings) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["quietHoursStart"],
          message: "quiet hours must be both HH:MM strings or both null",
        });
      }
    }

    if (typeof val.timezone === "string" && val.timezone && !isValidTimeZone(val.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: "Invalid IANA timezone",
      });
    }

    // New contract: if the client explicitly sets matchDeliveryMode=DIGEST, require an interval.
    if (val.matchDeliveryMode === "DIGEST") {
      const hasNewInterval = Object.prototype.hasOwnProperty.call(val, "digestIntervalMinutes");
      const hasLegacyInterval = Object.prototype.hasOwnProperty.call(val, "jobMatchDigestIntervalMinutes");
      if (!hasNewInterval && !hasLegacyInterval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["digestIntervalMinutes"],
          message: "digestIntervalMinutes is required when matchDeliveryMode is DIGEST",
        });
      }
    }
  });

function toApiRow(row: any) {
  const normalized = normalizePreference(row as any);
  return {
    userId: row.userId,
    jobMatchEnabled: !!row.jobMatchEnabled,
    // New fields
    matchDeliveryMode: normalized.matchDeliveryMode,
    digestIntervalMinutes: normalized.digestIntervalMinutes,

    // Legacy fields (keep returning for older clients)
    jobMatchDigestEnabled: normalized.matchDeliveryMode === "DIGEST",
    jobMatchDigestIntervalMinutes: normalized.digestIntervalMinutes,
    bidEnabled: !!row.bidEnabled,
    messageEnabled: !!row.messageEnabled,
    quietHoursStart: row.quietHoursStart ?? null,
    quietHoursEnd: row.quietHoursEnd ?? null,
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
  };
}

export function createGetMeNotificationPreferencesHandler(deps: {
  prisma: {
    notificationPreference: {
      findUnique: (args: any) => Promise<any>;
      create: (args: any) => Promise<any>;
    };
  };
}) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      let row = await prisma.notificationPreference.findUnique({
        where: { userId: req.user.userId },
      });

      if (!row) {
        row = await prisma.notificationPreference.create({
          data: {
            userId: req.user.userId,
            ...DEFAULT_NOTIFICATION_PREFERENCE,
          },
        });
      }

      return res.json(toApiRow(row));
    } catch (err) {
      if (isMissingTableOrRelationError(err)) {
        return res.json(
          toApiRow({
            userId: (req as any).user?.userId,
            ...DEFAULT_NOTIFICATION_PREFERENCE,
          })
        );
      }

      logger.error("me.notification_preferences_get_error", {
        message: String((err as any)?.message ?? err),
      });
      return res.status(500).json({ error: "Internal server error while fetching notification preferences." });
    }
  };
}

export function createPutMeNotificationPreferencesHandler(deps: {
  prisma: {
    notificationPreference: {
      upsert: (args: any) => Promise<any>;
    };
  };
}) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
        });
      }

      const body = parsed.data;

      const normalizedIncoming = normalizePreference({
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...body,
        // Allow legacy toggle to drive new mode.
        matchDeliveryMode:
          body.matchDeliveryMode ?? (body.jobMatchDigestEnabled ? "DIGEST" : "INSTANT"),
        // Prefer new interval, else legacy.
        digestIntervalMinutes:
          (body as any).digestIntervalMinutes ?? (body as any).jobMatchDigestIntervalMinutes,
      } as any);

      const jobMatchDigestEnabled = normalizedIncoming.matchDeliveryMode === "DIGEST";
      const jobMatchDigestIntervalMinutes = normalizedIncoming.digestIntervalMinutes;

      const updated = await prisma.notificationPreference.upsert({
        where: { userId: req.user.userId },
        create: {
          userId: req.user.userId,
          jobMatchEnabled: body.jobMatchEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchEnabled,
          jobMatchDigestEnabled,
          jobMatchDigestIntervalMinutes,
          bidEnabled: body.bidEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.bidEnabled,
          messageEnabled: body.messageEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.messageEnabled,
          quietHoursStart:
            Object.prototype.hasOwnProperty.call(body, "quietHoursStart") ? body.quietHoursStart : DEFAULT_NOTIFICATION_PREFERENCE.quietHoursStart,
          quietHoursEnd:
            Object.prototype.hasOwnProperty.call(body, "quietHoursEnd") ? body.quietHoursEnd : DEFAULT_NOTIFICATION_PREFERENCE.quietHoursEnd,
          timezone: body.timezone ?? DEFAULT_TIMEZONE,
        },
        update: {
          jobMatchEnabled: body.jobMatchEnabled,
          // Persist new settings via legacy columns (deploy-safe)
          jobMatchDigestEnabled: Object.prototype.hasOwnProperty.call(body, "matchDeliveryMode") || Object.prototype.hasOwnProperty.call(body, "digestIntervalMinutes")
            ? jobMatchDigestEnabled
            : body.jobMatchDigestEnabled,
          jobMatchDigestIntervalMinutes: Object.prototype.hasOwnProperty.call(body, "matchDeliveryMode") || Object.prototype.hasOwnProperty.call(body, "digestIntervalMinutes")
            ? jobMatchDigestIntervalMinutes
            : body.jobMatchDigestIntervalMinutes,
          bidEnabled: body.bidEnabled,
          messageEnabled: body.messageEnabled,
          quietHoursStart:
            Object.prototype.hasOwnProperty.call(body, "quietHoursStart") ? body.quietHoursStart : undefined,
          quietHoursEnd:
            Object.prototype.hasOwnProperty.call(body, "quietHoursEnd") ? body.quietHoursEnd : undefined,
          timezone: body.timezone,
        },
      });

      return res.json(toApiRow(updated));
    } catch (err) {
      if (isMissingTableOrRelationError(err)) {
        return res.json(
          toApiRow({
            userId: (req as any).user?.userId,
            ...DEFAULT_NOTIFICATION_PREFERENCE,
          })
        );
      }

      logger.error("me.notification_preferences_put_error", {
        message: String((err as any)?.message ?? err),
      });
      return res.status(500).json({ error: "Internal server error while updating notification preferences." });
    }
  };
}
