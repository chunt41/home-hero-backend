import os from "os";
import crypto from "node:crypto";
import { prisma } from "../prisma";
import { BackgroundJobStatus } from "@prisma/client";
import { processJobMatchNotify } from "../services/jobMatchNotifier";
import { processJobMatchDigest } from "../services/jobMatchDigest";
import { isRescheduleJobError } from "./jobErrors";
import { withLogContext } from "../services/logContext";
import { logger } from "../services/logger";
import { captureException, captureMessage } from "../observability/sentry";
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

async function markSuccess(
  jobId: number,
  workerId: string,
  deps?: {
    prisma?: any;
    now?: () => Date;
  }
) {
  const prismaClient = deps?.prisma ?? prisma;
  const nowFn = deps?.now ?? (() => new Date());
  const now = nowFn();
  await prismaClient.backgroundJob.updateMany({
    where: {
      id: jobId,
      status: BackgroundJobStatus.PROCESSING,
      lockedBy: workerId,
    },
    data: {
      status: BackgroundJobStatus.SUCCESS,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      lastAttemptAt: now,
    },
  });
}

async function markFailure(
  jobId: number,
  attempts: number,
  maxAttempts: number,
  err: unknown,
  workerId: string,
  deps?: {
    prisma?: any;
    now?: () => Date;
    captureMessage?: typeof captureMessage;
    logger?: typeof logger;
  }
) {
  const prismaClient = deps?.prisma ?? prisma;
  const nowFn = deps?.now ?? (() => new Date());
  const captureMessageFn = deps?.captureMessage ?? captureMessage;
  const log = deps?.logger ?? logger;
  const now = nowFn();

  if (isRescheduleJobError(err)) {
    await prismaClient.backgroundJob.updateMany({
      where: { id: jobId, status: BackgroundJobStatus.PROCESSING, lockedBy: workerId },
      data: {
        status: BackgroundJobStatus.PENDING,
        attempts,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        lastAttemptAt: now,
        runAt: err.runAt,
      },
    });
    return;
  }

  const message = String((err as any)?.message ?? err);
  const nextAttempts = attempts + 1;

  if (nextAttempts >= maxAttempts) {
    const updated = await prismaClient.backgroundJob.updateMany({
      where: { id: jobId, status: BackgroundJobStatus.PROCESSING, lockedBy: workerId },
      data: {
        status: "DEAD",
        attempts: nextAttempts,
        lockedAt: null,
        lockedBy: null,
        lastError: message,
        lastAttemptAt: now,
        runAt: now,
      },
    });

    if (updated.count > 0) {
      const sent = captureMessageFn("Background job dead-lettered", {
        level: "error",
        kind: "jobs.dead_lettered",
        jobId,
        attempts: nextAttempts,
        maxAttempts,
        lastError: message.slice(0, 500),
      });

      if (!sent) {
        log.error("jobs.dead_lettered", {
          jobId,
          attempts: nextAttempts,
          maxAttempts,
          lastError: message.slice(0, 500),
        });
      }
    }
    return;
  }

  const delayMs = computeBackoffMs(nextAttempts);
  await prismaClient.backgroundJob.updateMany({
    where: { id: jobId, status: BackgroundJobStatus.PROCESSING, lockedBy: workerId },
    data: {
      status: BackgroundJobStatus.PENDING,
      attempts: nextAttempts,
      lockedAt: null,
      lockedBy: null,
      lastError: message,
      lastAttemptAt: now,
      runAt: new Date(Date.now() + delayMs),
    },
  });
}

export const __testOnly = {
  markFailure,
  markSuccess,
};

async function processOne(job: any) {
  switch (job.type) {
    case "JOB_MATCH_NOTIFY":
      await processJobMatchNotify(job.payload);
      return;
    case "JOB_MATCH_DIGEST":
      await processJobMatchDigest(job.payload);
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
          const payloadAny = job?.payload as any;
          const inheritedRequestId =
            payloadAny && typeof payloadAny === "object" && !Array.isArray(payloadAny)
              ? payloadAny.requestId
              : undefined;
          const requestId =
            typeof inheritedRequestId === "string" && inheritedRequestId.trim()
              ? inheritedRequestId.trim()
              : `job-${job.id}-${crypto.randomUUID()}`;

          await withLogContext(
            { requestId, jobId: job.id, jobType: String(job.type ?? "unknown") },
            async () => {
              try {
                await processOne(job);
                await markSuccess(job.id, workerId);
                logger.info("jobs.job_success", { attempts: job.attempts ?? 0 });
              } catch (e) {
                logger.warn("jobs.job_failed", {
                  attempts: job.attempts ?? 0,
                  maxAttempts: job.maxAttempts ?? 8,
                  message: String((e as any)?.message ?? e),
                });
                captureException(e, {
                  kind: "job_failed",
                  jobId: job.id,
                  jobType: String(job.type ?? "unknown"),
                  attempts: job.attempts ?? 0,
                  maxAttempts: job.maxAttempts ?? 8,
                });
                await markFailure(job.id, job.attempts ?? 0, job.maxAttempts ?? 8, e, workerId);
              }
            }
          );
        }
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        logger.error("jobs.worker_loop_error", { message: msg });
        captureException(e, { kind: "jobs.worker_loop_error" });

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
    logger.error("jobs.schedule_failed", { jobType: "PROVIDER_STATS_RECOMPUTE", message: msg });
    captureException(e, { kind: "jobs.schedule_failed", jobType: "PROVIDER_STATS_RECOMPUTE" });
  });

  ensureAiMonthlyResetScheduled().catch((e) => {
    const msg = String((e as any)?.message ?? e);
    logger.error("jobs.schedule_failed", { jobType: "AI_MONTHLY_RESET", message: msg });
    captureException(e, { kind: "jobs.schedule_failed", jobType: "AI_MONTHLY_RESET" });
  });

  return () => {
    stopped = true;
  };
}
