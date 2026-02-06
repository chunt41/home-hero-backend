import type { PrismaClient } from "@prisma/client";

export type ProviderStatsSnapshot = {
  avgRating: number | null;
  ratingCount: number;

  jobsCompletedAllTime: number;
  jobsCompleted30d: number;

  medianResponseTimeSeconds30d: number | null;

  cancellationRate30d: number;
  disputeRate30d: number;
  reportRate30d: number;
};

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function computeMedianSeconds(values: number[]): number | null {
  const nums = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  if (nums.length === 0) return null;

  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return Math.round(nums[mid]);
  return Math.round((nums[mid - 1] + nums[mid]) / 2);
}

export function computeProviderStatsSnapshot(input: {
  avgRating: number | null;
  ratingCount: number;
  jobsCompletedAllTime: number;
  jobsCompleted30d: number;
  jobsFinished30d: number;
  jobsCancelled30d: number;
  responseTimesSeconds30d: number[];
  disputes30d: number;
  reports30d: number;
}): ProviderStatsSnapshot {
  const ratingCount = Math.max(0, Math.floor(input.ratingCount));
  const avgRating =
    ratingCount <= 0
      ? null
      : Number.isFinite(Number(input.avgRating))
        ? Number(input.avgRating)
        : null;

  const medianResponseTimeSeconds30d = computeMedianSeconds(input.responseTimesSeconds30d);

  const denom = Math.max(0, Math.floor(input.jobsFinished30d));
  const safeDenom = denom > 0 ? denom : 1;

  const cancellationRate30d = clampRate(input.jobsCancelled30d / safeDenom);
  const disputeRate30d = clampRate(input.disputes30d / safeDenom);
  const reportRate30d = clampRate(input.reports30d / safeDenom);

  return {
    avgRating: avgRating === null ? null : Math.max(0, Math.min(5, avgRating)),
    ratingCount,

    jobsCompletedAllTime: Math.max(0, Math.floor(input.jobsCompletedAllTime)),
    jobsCompleted30d: Math.max(0, Math.floor(input.jobsCompleted30d)),

    medianResponseTimeSeconds30d,

    cancellationRate30d,
    disputeRate30d,
    reportRate30d,
  };
}

function sinceDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function recomputeProviderStatsForProvider(params: {
  prisma: PrismaClient;
  providerId: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const since30d = sinceDays(now, 30);

  const providerId = params.providerId;
  const prisma = params.prisma;

  const [ratingAgg, jobsCompletedAllTime, jobsCompleted30d, jobsFinished30d, jobsCancelled30d, disputes30d, reports30d] =
    await Promise.all([
      prisma.review.aggregate({
        where: { revieweeUserId: providerId },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prisma.job.count({
        where: {
          status: "COMPLETED",
          bids: { some: { providerId, status: "ACCEPTED" } },
        },
      }),
      prisma.job.count({
        where: {
          status: "COMPLETED",
          createdAt: { gte: since30d },
          bids: { some: { providerId, status: "ACCEPTED" } },
        },
      }),
      prisma.job.count({
        where: {
          status: { in: ["COMPLETED", "CANCELLED"] },
          createdAt: { gte: since30d },
          bids: { some: { providerId, status: "ACCEPTED" } },
        },
      }),
      prisma.job.count({
        where: {
          status: "CANCELLED",
          createdAt: { gte: since30d },
          bids: { some: { providerId, status: "ACCEPTED" } },
        },
      }),
      prisma.dispute.count({
        where: {
          createdAt: { gte: since30d },
          job: {
            bids: { some: { providerId, status: "ACCEPTED" } },
          },
        },
      }),
      prisma.report.count({
        where: {
          createdAt: { gte: since30d },
          targetType: "USER",
          targetUserId: providerId,
        },
      }),
    ]);

  // Compute response time median over last 30d for jobs where provider participated.
  const messages = await prisma.message.findMany({
    where: {
      createdAt: { gte: since30d },
      job: {
        bids: { some: { providerId } },
      },
    },
    select: {
      createdAt: true,
      senderId: true,
      jobId: true,
      job: { select: { consumerId: true } },
    },
    orderBy: [{ jobId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const responseTimesSeconds30d: number[] = [];
  const pendingConsumerMessageAtByJob = new Map<number, Date>();

  for (const msg of messages) {
    const consumerId = msg.job.consumerId;

    if (msg.senderId === consumerId) {
      pendingConsumerMessageAtByJob.set(msg.jobId, msg.createdAt);
      continue;
    }

    if (msg.senderId === providerId) {
      const pending = pendingConsumerMessageAtByJob.get(msg.jobId);
      if (pending) {
        const deltaSec = Math.max(0, Math.round((msg.createdAt.getTime() - pending.getTime()) / 1000));
        responseTimesSeconds30d.push(deltaSec);
        pendingConsumerMessageAtByJob.delete(msg.jobId);
      }
    }
  }

  const snapshot = computeProviderStatsSnapshot({
    avgRating: ratingAgg._avg.rating ?? null,
    ratingCount: ratingAgg._count.rating,
    jobsCompletedAllTime,
    jobsCompleted30d,
    jobsFinished30d,
    jobsCancelled30d,
    responseTimesSeconds30d,
    disputes30d,
    reports30d,
  });

  await prisma.providerStats.upsert({
    where: { providerId },
    create: {
      providerId,
      avgRating: snapshot.avgRating,
      ratingCount: snapshot.ratingCount,
      jobsCompletedAllTime: snapshot.jobsCompletedAllTime,
      jobsCompleted30d: snapshot.jobsCompleted30d,
      medianResponseTimeSeconds30d: snapshot.medianResponseTimeSeconds30d,
      cancellationRate30d: snapshot.cancellationRate30d,
      disputeRate30d: snapshot.disputeRate30d,
      reportRate30d: snapshot.reportRate30d,
    },
    update: {
      avgRating: snapshot.avgRating,
      ratingCount: snapshot.ratingCount,
      jobsCompletedAllTime: snapshot.jobsCompletedAllTime,
      jobsCompleted30d: snapshot.jobsCompleted30d,
      medianResponseTimeSeconds30d: snapshot.medianResponseTimeSeconds30d,
      cancellationRate30d: snapshot.cancellationRate30d,
      disputeRate30d: snapshot.disputeRate30d,
      reportRate30d: snapshot.reportRate30d,
    },
  });
}

export async function recomputeProviderStatsForAllProviders(params: {
  prisma: PrismaClient;
  now?: Date;
}): Promise<{ providersProcessed: number }>{
  const now = params.now ?? new Date();

  const providers = await params.prisma.user.findMany({
    where: { role: "PROVIDER" },
    select: { id: true },
  });

  for (const p of providers) {
    await recomputeProviderStatsForProvider({ prisma: params.prisma, providerId: p.id, now });
  }

  return { providersProcessed: providers.length };
}

export function getNextDailyRunAtUtc(params: { now: Date; hourUtc: number }): Date {
  const hourUtc = Math.max(0, Math.min(23, Math.floor(params.hourUtc)));
  const now = params.now;

  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}
