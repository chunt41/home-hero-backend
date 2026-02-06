import os from "os";
import { prisma } from "../prisma";
import { BackgroundJobStatus } from "@prisma/client";
import { processJobMatchNotify } from "../services/jobMatchNotifier";
import {
  getNextDailyRunAtUtc,
  recomputeProviderStatsForAllProviders,
  recomputeProviderStatsForProvider,
} from "../services/providerStats";
import { getCurrentMonthKeyUtc, resetAiUsageForNewMonth } from "../ai/aiGateway";

const WORKER_POLL_MS = Number(process.env.MATCH_WORKER_POLL_MS ?? 1000);
const BATCH_SIZE = Number(process.env.MATCH_WORKER_BATCH_SIZE ?? 20);
const PROCESSING_LEASE_MS = Number(process.env.MATCH_PROCESSING_LEASE_MS ?? 30_000);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeBackoffMs(attempt: number) {
  const baseMs = Number(process.env.MATCH_RETRY_BASE_MS ?? 2_000);
  const maxMs = Number(process.env.MATCH_RETRY_MAX_MS ?? 10 * 60_000);

  // Exponential backoff with jitter
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp * 0.2));
  return Math.min(maxMs, exp + jitter);
}

async function releaseStaleLeases() {
  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  await prisma.backgroundJob.updateMany({
    where: {
      status: BackgroundJobStatus.PROCESSING,
      lockedAt: { lt: staleBefore },
    },
    data: {
      status: BackgroundJobStatus.PENDING,
      lockedAt: null,
      lockedBy: null,
    },
  });
}

async function claimDueJobs(workerId: string) {
  const now = new Date();

  type BackgroundJobRow = Awaited<ReturnType<typeof prisma.backgroundJob.findMany>>[number];

  return prisma.$transaction(async (tx): Promise<BackgroundJobRow[]> => {
    const candidates = await tx.backgroundJob.findMany({
      where: {
        status: BackgroundJobStatus.PENDING,
        runAt: { lte: now },
      },
      orderBy: [{ runAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
      select: { id: true },
    });

    if (!candidates.length) return [];

    const ids = candidates.map((c) => c.id);

    await tx.backgroundJob.updateMany({
      where: { id: { in: ids }, status: BackgroundJobStatus.PENDING },
      data: {
        status: BackgroundJobStatus.PROCESSING,
        lockedAt: now,
        lockedBy: workerId,
      },
    });

    const claimed = await tx.backgroundJob.findMany({
      where: { id: { in: ids }, status: BackgroundJobStatus.PROCESSING, lockedBy: workerId },
      orderBy: [{ runAt: "asc" }, { id: "asc" }],
    });

    return claimed;
  });
}

async function markSuccess(jobId: number) {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: BackgroundJobStatus.SUCCESS,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

async function markFailure(jobId: number, attempts: number, maxAttempts: number, err: unknown) {
  const message = String((err as any)?.message ?? err);
  const nextAttempts = attempts + 1;

  if (nextAttempts >= maxAttempts) {
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: BackgroundJobStatus.FAILED,
        attempts: nextAttempts,
        lockedAt: null,
        lockedBy: null,
        lastError: message,
        runAt: new Date(),
      },
    });
    return;
  }

  const delayMs = computeBackoffMs(nextAttempts);
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: BackgroundJobStatus.PENDING,
      attempts: nextAttempts,
      lockedAt: null,
      lockedBy: null,
      lastError: message,
      runAt: new Date(Date.now() + delayMs),
    },
  });
}

async function processOne(job: any) {
  switch (job.type) {
    case "JOB_MATCH_NOTIFY":
      await processJobMatchNotify(job.payload);
      return;
    case "PROVIDER_STATS_RECOMPUTE": {
      const providerId = Number(job.payload?.providerId);
      if (Number.isFinite(providerId) && providerId > 0) {
        await recomputeProviderStatsForProvider({ prisma, providerId });
      } else {
        await recomputeProviderStatsForAllProviders({ prisma });
      }

      // Self-schedule next daily run (only for the global job).
      if (!Number.isFinite(providerId) || providerId <= 0) {
        await ensureProviderStatsRecomputeScheduled();
      }
      return;
    }
    case "AI_MONTHLY_RESET": {
      await resetAiUsageForNewMonth();
      await ensureAiMonthlyResetScheduled();
      return;
    }
    default:
      throw new Error(`Unknown background job type: ${job.type}`);
  }
}

function getNextMonthRunAtUtc(params: { now: Date; hourUtc: number }): Date {
  const y = params.now.getUTCFullYear();
  const m = params.now.getUTCMonth();
  const next = new Date(Date.UTC(y, m + 1, 1, params.hourUtc, 0, 0));
  return next;
}

async function ensureAiMonthlyResetScheduled() {
  const now = new Date();
  const missingSchema = (err: unknown) => {
    const msg = String((err as any)?.message ?? err);
    return /column|relation/i.test(msg) && /does not exist/i.test(msg);
  };

  const existing = await prisma.backgroundJob.findFirst({
    where: {
      type: "AI_MONTHLY_RESET",
      status: { in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.PROCESSING] },
      runAt: { gte: now },
    },
    select: { id: true, runAt: true },
    orderBy: [{ runAt: "asc" }, { id: "asc" }],
  });

  if (existing) return;

  const mk = getCurrentMonthKeyUtc();
  const hourUtc = Number(process.env.AI_USAGE_RESET_HOUR_UTC ?? 0);

  // If some users haven't rolled over yet, run soon to backfill.
  const needsReset = await prisma.user
    .findFirst({
      where: { OR: [{ aiUsageMonthKey: null }, { aiUsageMonthKey: { not: mk } }] },
      select: { id: true },
    })
    .then((u) => !!u)
    .catch((e) => {
      if (missingSchema(e)) return false;
      throw e;
    });

  const runAt = needsReset ? new Date(now.getTime() + 10_000) : getNextMonthRunAtUtc({ now, hourUtc });

  await prisma.backgroundJob.create({
    data: {
      type: "AI_MONTHLY_RESET",
      payload: { scope: "ALL" },
      runAt,
      maxAttempts: 3,
    },
  }).catch((e) => {
    if (missingSchema(e)) return;
    throw e;
  });
}

async function ensureProviderStatsRecomputeScheduled() {
  const now = new Date();
  const existing = await prisma.backgroundJob.findFirst({
    where: {
      type: "PROVIDER_STATS_RECOMPUTE",
      status: { in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.PROCESSING] },
      runAt: { gte: now },
    },
    select: { id: true, runAt: true },
    orderBy: [{ runAt: "asc" }, { id: "asc" }],
  });

  if (existing) return;

  const statsCount = await prisma.providerStats.count().catch(() => 0);
  const hourUtc = Number(process.env.PROVIDER_STATS_RECOMPUTE_HOUR_UTC ?? 4);
  const runAt = statsCount === 0 ? new Date(now.getTime() + 10_000) : getNextDailyRunAtUtc({ now, hourUtc });

  await prisma.backgroundJob.create({
    data: {
      type: "PROVIDER_STATS_RECOMPUTE",
      payload: { scope: "ALL" },
      runAt,
      maxAttempts: 3,
    },
  });
}

export function startBackgroundJobWorker() {
  const workerId = `${os.hostname()}-${process.pid}`;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await releaseStaleLeases();

        const jobs = await claimDueJobs(workerId);
        if (!jobs.length) {
          await sleep(WORKER_POLL_MS);
          continue;
        }

        for (const job of jobs) {
          try {
            await processOne(job);
            await markSuccess(job.id);
          } catch (e) {
            await markFailure(job.id, job.attempts ?? 0, job.maxAttempts ?? 8, e);
          }
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error("[jobs] worker loop error:", msg);

        // Deploy-safe: if the migration hasn't been applied yet, don't spin hot.
        if (/relation/i.test(msg) && /BackgroundJob/i.test(msg) && /does not exist/i.test(msg)) {
          await sleep(10_000);
        } else {
          await sleep(Math.max(250, WORKER_POLL_MS));
        }
      }
    }
  };

  loop();

  // Best-effort schedule (safe to call even if migration isn't applied yet).
  ensureProviderStatsRecomputeScheduled().catch((e) => {
    const msg = String((e as any)?.message ?? e);
    console.error("[jobs] failed to schedule PROVIDER_STATS_RECOMPUTE:", msg);
  });

  ensureAiMonthlyResetScheduled().catch((e) => {
    const msg = String((e as any)?.message ?? e);
    console.error("[jobs] failed to schedule AI_MONTHLY_RESET:", msg);
  });

  return () => {
    stopped = true;
  };
}
