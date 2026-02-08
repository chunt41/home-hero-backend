import type { Request, Response } from "express";
import { z } from "zod";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const takeSchema = z.object({
  take: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export function createGetAdminOpsWebhookDeadlettersHandler(deps: { prisma: any }) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });

    const parsed = takeSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    }

    const { take } = parsed.data;

    const items = await prisma.webhookDelivery.findMany({
      where: { status: "DEAD" },
      take,
      orderBy: { id: "desc" },
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        lastError: true,
        lastStatusCode: true,
        lastAttemptAt: true,
        nextAttempt: true,
        createdAt: true,
        updatedAt: true,
        endpoint: { select: { id: true, url: true, enabled: true } },
      },
    });

    return res.json({ items });
  };
}

export function createGetAdminOpsMatchDeadlettersHandler(deps: { prisma: any }) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });

    const parsed = takeSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    }

    const { take } = parsed.data;

    const items = await prisma.backgroundJob.findMany({
      where: {
        status: "DEAD",
        type: { in: ["JOB_MATCH_NOTIFY", "JOB_MATCH_DIGEST"] },
      },
      take,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        lastAttemptAt: true,
        runAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ items });
  };
}
