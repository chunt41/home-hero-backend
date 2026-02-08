import type { Request, Response } from "express";
import { z } from "zod";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const querySchema = z.object({
  take: z.coerce.number().int().min(1).max(500).optional().default(200),
  sinceHours: z.coerce.number().int().min(1).max(24 * 30).optional().default(72),
  actionTypes: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined)),
});

const DEFAULT_SAFETY_ACTION_TYPES = [
  "message.blocked",
  "message.shadow_hidden",
  "job.spam_signal",
  "job.shadow_hidden",
  "bid.blocked",
  "bid.spam_signal",
  "report.created",
  "user.restricted",
  "admin.user_restriction_cleared",
  "admin.job_unhidden",
  "admin.message_unhidden",
];

export function createGetAdminOpsSafetyEventsHandler(deps: { prisma: any }) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });

      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
      }

      const { take, sinceHours, actionTypes } = parsed.data;
      const since = new Date(Date.now() - sinceHours * 60 * 60_000);

      const types = Array.isArray(actionTypes) && actionTypes.length ? actionTypes : DEFAULT_SAFETY_ACTION_TYPES;

      const items = await prisma.securityEvent.findMany({
        where: {
          actionType: { in: types },
          createdAt: { gte: since },
        },
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          actionType: true,
          actorUserId: true,
          actorRole: true,
          actorEmail: true,
          targetType: true,
          targetId: true,
          ip: true,
          userAgent: true,
          metadataJson: true,
          createdAt: true,
        },
      });

      return res.json({
        filters: {
          take,
          sinceHours,
          since,
          actionTypes: types,
        },
        items: (items ?? []).map((e: any) => ({
          id: e.id,
          createdAt: e.createdAt,
          actionType: e.actionType,
          actorUserId: e.actorUserId,
          actorRole: e.actorRole,
          actorEmail: e.actorEmail,
          targetType: e.targetType,
          targetId: e.targetId,
          ip: e.ip,
          userAgent: e.userAgent,
          metadata: e.metadataJson ?? null,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: "Internal server error while fetching safety events." });
    }
  };
}
