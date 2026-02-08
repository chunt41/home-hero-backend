import type { Request, Response } from "express";
import { z } from "zod";

import { logger } from "../services/logger";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const querySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional().default(30),
  maxJobsForBidLatency: z.coerce.number().int().min(1).max(5000).optional().default(1000),
});

function msToMinutes(ms: number): number {
  return Math.round((ms / 60000) * 10) / 10;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const idx = (sorted.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function average(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function createGetAdminOpsKpisHandler(deps: {
  prisma: any;
  now?: () => Date;
}) {
  const { prisma } = deps;
  const nowFn = deps.now ?? (() => new Date());

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admin only." });

      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
      }

      const { windowDays, maxJobsForBidLatency } = parsed.data;

      const endAt = nowFn();
      const startAt = new Date(endAt.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const expiringSoonEndAt = new Date(endAt.getTime() + 7 * 24 * 60 * 60 * 1000);

      const [
        jobsPosted,
        jobsAwarded,
        messagesCreated,
        reportsCreated,
        reportsByTargetTypeRaw,
        activePaidSubsByTierRaw,
        churnedPaidSubsByTierRaw,
        expiringSoonPaidSubsByTierRaw,
        successfulSubPaymentsByTierRaw,
      ] = await Promise.all([
        prisma.job.count({ where: { createdAt: { gte: startAt } } }),
        prisma.job.count({ where: { createdAt: { gte: startAt }, awardedAt: { not: null } } }),
        prisma.message.count({ where: { createdAt: { gte: startAt } } }),
        prisma.report.count({ where: { createdAt: { gte: startAt } } }),
        prisma.report.groupBy({
          by: ["targetType"],
          where: { createdAt: { gte: startAt } },
          _count: { _all: true },
        }),
        prisma.subscription.groupBy({
          by: ["tier"],
          where: {
            tier: { not: "FREE" },
            renewsAt: { gte: endAt },
          },
          _count: { _all: true },
        }),
        prisma.subscription.groupBy({
          by: ["tier"],
          where: {
            tier: { not: "FREE" },
            renewsAt: { lt: endAt, gte: startAt },
          },
          _count: { _all: true },
        }),
        prisma.subscription.groupBy({
          by: ["tier"],
          where: {
            tier: { not: "FREE" },
            renewsAt: { gte: endAt, lt: expiringSoonEndAt },
          },
          _count: { _all: true },
        }),
        prisma.stripePayment.groupBy({
          by: ["tier"],
          where: {
            status: "SUCCEEDED",
            kind: "SUBSCRIPTION",
            createdAt: { gte: startAt },
          },
          _count: { _all: true },
        }),
      ]);

      const reportsByTargetType: Record<string, number> = {};
      for (const row of reportsByTargetTypeRaw ?? []) {
        const k = String((row as any).targetType ?? "UNKNOWN");
        reportsByTargetType[k] = Number((row as any)._count?._all ?? 0);
      }

      const activePaidByTier: Record<string, number> = {};
      for (const row of activePaidSubsByTierRaw ?? []) {
        const k = String((row as any).tier ?? "UNKNOWN");
        activePaidByTier[k] = Number((row as any)._count?._all ?? 0);
      }

      const churnedByTier: Record<string, number> = {};
      for (const row of churnedPaidSubsByTierRaw ?? []) {
        const k = String((row as any).tier ?? "UNKNOWN");
        churnedByTier[k] = Number((row as any)._count?._all ?? 0);
      }

      const expiringSoonByTier: Record<string, number> = {};
      for (const row of expiringSoonPaidSubsByTierRaw ?? []) {
        const k = String((row as any).tier ?? "UNKNOWN");
        expiringSoonByTier[k] = Number((row as any)._count?._all ?? 0);
      }

      const successfulSubscriptionPaymentsByTier: Record<string, number> = {};
      for (const row of successfulSubPaymentsByTierRaw ?? []) {
        const k = String((row as any).tier ?? "UNKNOWN");
        successfulSubscriptionPaymentsByTier[k] = Number((row as any)._count?._all ?? 0);
      }

      const churnRateByTier: Record<string, number | null> = {};
      const tiers = new Set<string>([
        ...Object.keys(activePaidByTier),
        ...Object.keys(churnedByTier),
      ]);
      for (const tier of tiers) {
        const active = Number(activePaidByTier[tier] ?? 0);
        const expired = Number(churnedByTier[tier] ?? 0);
        const denom = active + expired;
        churnRateByTier[tier] = denom > 0 ? expired / denom : null;
      }

      // Time-to-first-bid (bounded sample for safety)
      const jobsForLatency = await prisma.job.findMany({
        where: { createdAt: { gte: startAt } },
        orderBy: { createdAt: "desc" },
        take: maxJobsForBidLatency,
        select: {
          id: true,
          createdAt: true,
          bids: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          },
        },
      });

      const diffsMs: number[] = [];
      for (const j of jobsForLatency ?? []) {
        const firstBidAt = j.bids?.[0]?.createdAt;
        if (!firstBidAt) continue;
        const dt = new Date(firstBidAt).getTime() - new Date(j.createdAt).getTime();
        if (Number.isFinite(dt) && dt >= 0) diffsMs.push(dt);
      }
      diffsMs.sort((a, b) => a - b);

      const avgMs = average(diffsMs);
      const p50Ms = percentile(diffsMs, 0.5);
      const p90Ms = percentile(diffsMs, 0.9);

      const postToAwardConversion = jobsPosted > 0 ? jobsAwarded / jobsPosted : null;
      const reportRatePer100Jobs = jobsPosted > 0 ? (reportsCreated / jobsPosted) * 100 : null;
      const reportRatePer1000Messages = messagesCreated > 0 ? (reportsCreated / messagesCreated) * 1000 : null;

      return res.json({
        windowDays,
        startAt,
        endAt,
        timeToFirstBid: {
          sampledJobs: jobsForLatency.length,
          jobsWithAtLeastOneBid: diffsMs.length,
          avgMinutes: avgMs === null ? null : msToMinutes(avgMs),
          p50Minutes: p50Ms === null ? null : msToMinutes(p50Ms),
          p90Minutes: p90Ms === null ? null : msToMinutes(p90Ms),
        },
        postToAwardConversion: {
          jobsPosted,
          jobsAwarded,
          conversion: postToAwardConversion,
        },
        churnByTier: {
          churnDefinition:
            "ExpiredWithinWindow counts paid subscriptions (tier != FREE) whose renewsAt fell within the window (startAt..endAt). This is an approximation of churn (no-grace-period, no-renewal-matching).",
          activePaidByTier,
          churnedByTier,
          expiringSoonByTier,
          successfulSubscriptionPaymentsByTier,
          churnRateByTier,
        },
        reportRate: {
          reportsCreated,
          reportsByTargetType,
          jobsPosted,
          messagesCreated,
          per100JobsPosted: reportRatePer100Jobs,
          per1000MessagesCreated: reportRatePer1000Messages,
        },
      });
    } catch (err) {
      logger.error("admin.ops.kpis_error", { message: String((err as any)?.message ?? err) });
      return res.status(500).json({ error: "Internal server error while computing KPIs." });
    }
  };
}

export const __private = {
  percentile,
  average,
};
