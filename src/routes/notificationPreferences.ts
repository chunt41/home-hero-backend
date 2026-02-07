import type { Request, Response } from "express";
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  DEFAULT_TIMEZONE,
} from "../services/notificationPreferences";

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
  });

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

      return res.json({
        userId: row.userId,
        jobMatchEnabled: !!row.jobMatchEnabled,
        bidEnabled: !!row.bidEnabled,
        messageEnabled: !!row.messageEnabled,
        quietHoursStart: row.quietHoursStart ?? null,
        quietHoursEnd: row.quietHoursEnd ?? null,
        timezone: row.timezone ?? DEFAULT_TIMEZONE,
      });
    } catch (err) {
      if (isMissingTableOrRelationError(err)) {
        return res.json({
          userId: (req as any).user?.userId,
          ...DEFAULT_NOTIFICATION_PREFERENCE,
        });
      }

      console.error("GET /me/notification-preferences error:", err);
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

      const updated = await prisma.notificationPreference.upsert({
        where: { userId: req.user.userId },
        create: {
          userId: req.user.userId,
          jobMatchEnabled: body.jobMatchEnabled ?? DEFAULT_NOTIFICATION_PREFERENCE.jobMatchEnabled,
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
          bidEnabled: body.bidEnabled,
          messageEnabled: body.messageEnabled,
          quietHoursStart:
            Object.prototype.hasOwnProperty.call(body, "quietHoursStart") ? body.quietHoursStart : undefined,
          quietHoursEnd:
            Object.prototype.hasOwnProperty.call(body, "quietHoursEnd") ? body.quietHoursEnd : undefined,
          timezone: body.timezone,
        },
      });

      return res.json({
        userId: updated.userId,
        jobMatchEnabled: !!updated.jobMatchEnabled,
        bidEnabled: !!updated.bidEnabled,
        messageEnabled: !!updated.messageEnabled,
        quietHoursStart: updated.quietHoursStart ?? null,
        quietHoursEnd: updated.quietHoursEnd ?? null,
        timezone: updated.timezone ?? DEFAULT_TIMEZONE,
      });
    } catch (err) {
      if (isMissingTableOrRelationError(err)) {
        return res.json({
          userId: (req as any).user?.userId,
          ...DEFAULT_NOTIFICATION_PREFERENCE,
        });
      }

      console.error("PUT /me/notification-preferences error:", err);
      return res.status(500).json({ error: "Internal server error while updating notification preferences." });
    }
  };
}
