import type { Request, Response } from "express";
import { z } from "zod";
import { getCurrentMonthKeyUtc } from "../ai/aiGateway";
import { getAiMonthlyUserAlertThresholdTokens } from "../ai/aiConfig";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
  isImpersonated?: boolean;
};

export type AuthRequest = Request & { user?: AuthUser };

const querySchema = z.object({
  monthKey: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  topUsersLimit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

function monthKeyToRangeUtc(monthKey: string): { start: Date; end: Date } {
  const [yStr, mStr] = monthKey.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error("Invalid monthKey");
  }
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  return { start, end };
}

export function createGetAdminAiMetricsHandler(deps: { prisma: any }) {
  const { prisma } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.isImpersonated) return res.status(403).json({ error: "Admin access not allowed while impersonating." });
      if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });

      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
      }

      const monthKey = parsed.data.monthKey ?? getCurrentMonthKeyUtc();
      const { start, end } = monthKeyToRangeUtc(monthKey);
      const topUsersLimit = parsed.data.topUsersLimit;

      const [proAgg, basicAgg, freeAgg] = await Promise.all([
        prisma.user.aggregate({
          where: {
            aiUsageMonthKey: monthKey,
            aiTokensUsedThisMonth: { gt: 0 },
            subscription: { is: { tier: "PRO" } },
          },
          _sum: { aiTokensUsedThisMonth: true },
          _count: { _all: true },
        }),
        prisma.user.aggregate({
          where: {
            aiUsageMonthKey: monthKey,
            aiTokensUsedThisMonth: { gt: 0 },
            subscription: { is: { tier: "BASIC" } },
          },
          _sum: { aiTokensUsedThisMonth: true },
          _count: { _all: true },
        }),
        prisma.user.aggregate({
          where: {
            aiUsageMonthKey: monthKey,
            aiTokensUsedThisMonth: { gt: 0 },
            OR: [{ subscription: { is: null } }, { subscription: { is: { tier: "FREE" } } }],
          },
          _sum: { aiTokensUsedThisMonth: true },
          _count: { _all: true },
        }),
      ]);

      const [cacheHits, providerCalls, blockedCalls] = await Promise.all([
        prisma.securityEvent.count({
          where: { actionType: "ai.cache_hit", createdAt: { gte: start, lt: end } },
        }),
        prisma.securityEvent.count({
          where: { actionType: "ai.provider_call", createdAt: { gte: start, lt: end } },
        }),
        prisma.securityEvent.count({
          where: { actionType: "ai.blocked_quota", createdAt: { gte: start, lt: end } },
        }),
      ]);

      const topUsers = await prisma.user.findMany({
        where: { aiUsageMonthKey: monthKey, aiTokensUsedThisMonth: { gt: 0 } },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          aiMonthlyTokenLimit: true,
          aiTokensUsedThisMonth: true,
          subscription: { select: { tier: true } },
        },
        orderBy: [{ aiTokensUsedThisMonth: "desc" }, { id: "asc" }],
        take: topUsersLimit,
      });

      const denom = cacheHits + providerCalls;
      const cacheHitRatio = denom > 0 ? cacheHits / denom : null;

      return res.json({
        monthKey,
        window: { start, end },
        tokensUsedPerTier: {
          FREE: {
            activeUsers: Number(freeAgg?._count?._all ?? 0),
            tokensUsed: Number(freeAgg?._sum?.aiTokensUsedThisMonth ?? 0),
          },
          BASIC: {
            activeUsers: Number(basicAgg?._count?._all ?? 0),
            tokensUsed: Number(basicAgg?._sum?.aiTokensUsedThisMonth ?? 0),
          },
          PRO: {
            activeUsers: Number(proAgg?._count?._all ?? 0),
            tokensUsed: Number(proAgg?._sum?.aiTokensUsedThisMonth ?? 0),
          },
        },
        cache: {
          hits: cacheHits,
          providerCalls,
          hitRatio: cacheHitRatio,
        },
        cacheHitRatio,
        blockedCalls: blockedCalls,
        blockedCallsCount: blockedCalls,
        topCostUsers: topUsers.map((u: any) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          tier: u.subscription?.tier ?? "FREE",
          aiMonthlyTokenLimit: u.aiMonthlyTokenLimit ?? null,
          aiTokensUsedThisMonth: u.aiTokensUsedThisMonth ?? 0,
        })),
        alert: {
          monthlyUserThresholdTokens: getAiMonthlyUserAlertThresholdTokens(),
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal server error while fetching AI metrics." });
    }
  };
}
