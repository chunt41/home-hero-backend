import type { Request, Response } from "express";
import { logger } from "../services/logger";

function parsePositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : Array.isArray(v) ? Number(v[0]) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

export function createGetAdminMessageViolationsHandler(params: {
  prisma: any;
  defaultWindowMinutes?: number;
  defaultMinBlocks?: number;
  defaultLimit?: number;
}) {
  const defaultWindowMinutes = params.defaultWindowMinutes ?? 10;
  const defaultMinBlocks = params.defaultMinBlocks ?? 3;
  const defaultLimit = params.defaultLimit ?? 50;

  return async (req: Request, res: Response) => {
    try {
      const user = (req as any).user as { userId: number; role: string } | undefined;
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (user.role !== "ADMIN") return res.status(403).json({ error: "Admins only" });

      const windowMinutes = parsePositiveInt((req.query as any).windowMinutes, defaultWindowMinutes);
      const minBlocks = parsePositiveInt((req.query as any).minBlocks, defaultMinBlocks);
      const limit = Math.min(parsePositiveInt((req.query as any).limit, defaultLimit), 200);

      const since = new Date(Date.now() - windowMinutes * 60_000);

      const grouped = await params.prisma.securityEvent.groupBy({
        by: ["actorUserId"],
        where: {
          actionType: "message.blocked",
          createdAt: { gte: since },
          actorUserId: { not: null },
        },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: "desc" } },
      });

      const offenders = (grouped ?? [])
        .filter((g: any) => typeof g.actorUserId === "number" && (g._count?._all ?? 0) >= minBlocks)
        .slice(0, limit);

      const ids = offenders.map((o: any) => o.actorUserId);
      const users = ids.length
        ? await params.prisma.user.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              email: true,
              name: true,
              role: true,
              riskScore: true,
              restrictedUntil: true,
              isSuspended: true,
              createdAt: true,
            },
          })
        : [];

      const userById = new Map<number, any>(users.map((u: any) => [u.id, u]));

      return res.json({
        windowMinutes,
        minBlocks,
        users: offenders.map((o: any) => {
          const u = userById.get(o.actorUserId) ?? null;
          return {
            userId: o.actorUserId,
            blockCount: o._count?._all ?? 0,
            lastBlockedAt: o._max?.createdAt ?? null,
            user: u
              ? {
                  id: u.id,
                  email: u.email,
                  name: u.name,
                  role: u.role,
                  riskScore: u.riskScore,
                  restrictedUntil: u.restrictedUntil,
                  isSuspended: u.isSuspended,
                  createdAt: u.createdAt,
                }
              : null,
          };
        }),
      });
    } catch (err) {
      logger.error("admin.messages.violations_error", {
        message: String((err as any)?.message ?? err),
      });
      return res.status(500).json({ error: "Internal server error while fetching violations." });
    }
  };
}
