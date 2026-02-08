import { prisma } from "../prisma";
import { isExpoPushToken, sendExpoPush } from "./expoPush";
import { getNextAllowedSendAt, normalizePreference } from "./notificationPreferences";
import { RescheduleJobError } from "../jobs/jobErrors";

export type JobMatchDigestPayload = {
  providerId: number;
};

function isMissingTableOrRelationError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "");
  return (/relation/i.test(msg) || /table/i.test(msg) || /column/i.test(msg)) && /does not exist/i.test(msg);
}

function clampIntervalMinutes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  return Math.max(5, Math.min(1440, Math.floor(n)));
}

function computeNextIntervalAt(params: { now: Date; lastSentAt: Date | null; intervalMinutes: number }): Date {
  if (!params.lastSentAt) return params.now;
  return new Date(params.lastSentAt.getTime() + params.intervalMinutes * 60_000);
}

export async function processJobMatchDigestWithDeps(deps: {
  prisma: typeof prisma;
  sendExpoPush: typeof sendExpoPush;
  now?: Date;
  payload: JobMatchDigestPayload;
}): Promise<void> {
  const { prisma: prismaDep, sendExpoPush: sendExpoPushDep } = deps;
  const now = deps.now ?? new Date();

  const providerId = Number(deps.payload?.providerId);
  if (!Number.isFinite(providerId) || providerId <= 0) {
    throw new Error("JOB_MATCH_DIGEST missing providerId");
  }

  const prefRow = await prismaDep.notificationPreference
    .findUnique({ where: { userId: providerId } })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return null;
      throw e;
    });

  const pref = normalizePreference(prefRow as any);

  if (!pref.jobMatchEnabled) return;
  if (!pref.jobMatchDigestEnabled) return;

  const intervalMinutes = clampIntervalMinutes(pref.jobMatchDigestIntervalMinutes);
  const lastSentAt = pref.jobMatchDigestLastSentAt ? new Date(pref.jobMatchDigestLastSentAt) : null;

  const nextIntervalAt = computeNextIntervalAt({ now, lastSentAt, intervalMinutes });
  if (nextIntervalAt.getTime() > now.getTime() + 1_000) {
    throw new RescheduleJobError(nextIntervalAt, "Digest interval not reached");
  }

  const nextAllowedAt = getNextAllowedSendAt(prefRow as any, now);
  if (nextAllowedAt.getTime() > now.getTime() + 1_000) {
    const runAt = nextAllowedAt.getTime() > nextIntervalAt.getTime() ? nextAllowedAt : nextIntervalAt;
    throw new RescheduleJobError(runAt, "Quiet hours active");
  }

  const wherePending = {
    providerId,
    digestedAt: null,
    job: {
      isHidden: false,
    },
  } as const;

  const count = await prismaDep.jobMatchNotification.count({ where: wherePending as any }).catch((e) => {
    if (isMissingTableOrRelationError(e)) return 0;
    throw e;
  });

  if (!count) return;

  const topN = Number(process.env.MATCH_DIGEST_TOP_N ?? 3);
  const take = Math.max(1, Math.min(10, Number.isFinite(topN) ? topN : 3));

  const top = await prismaDep.jobMatchNotification
    .findMany({
      where: wherePending as any,
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        jobId: true,
        score: true,
        createdAt: true,
        job: {
          select: {
            id: true,
            title: true,
            location: true,
            category: true,
          },
        },
      },
    })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return [];
      throw e;
    });

  const first = top[0]?.job;
  const title = `${count} new job match${count === 1 ? "" : "es"}`;
  const body =
    count === 1
      ? first?.location
        ? `${first.title} • ${first.location}`
        : first?.title ?? "Open the app to view"
      : first?.title
        ? `${first.title} and ${count - 1} more`
        : `Open the app to view ${count} matches`;

  const notification = await prismaDep.notification
    .create({
      data: {
        userId: providerId,
        type: "job.match.digest",
        content: {
          title,
          body,
          count,
          topMatches: top.map((t) => ({
            jobId: t.jobId,
            title: t.job?.title,
            location: t.job?.location,
            category: t.job?.category,
            score: t.score ?? null,
          })),
          generatedAt: now.toISOString(),
        },
      },
    })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return null;
      throw e;
    });

  await prismaDep.jobMatchNotification
    .updateMany({
      where: { providerId, digestedAt: null } as any,
      data: { digestedAt: now } as any,
    })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return;
      throw e;
    });

  await prismaDep.notificationPreference
    .update({
      where: { userId: providerId },
      data: { jobMatchDigestLastSentAt: now } as any,
    })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return;
      throw e;
    });

  const user = await prismaDep.user
    .findUnique({
      where: { id: providerId },
      select: { pushTokens: { select: { token: true, platform: true } } },
    })
    .catch((e) => {
      if (isMissingTableOrRelationError(e)) return null;
      throw e;
    });

  const tokens = (user?.pushTokens ?? []).map((t) => t.token).filter((t) => isExpoPushToken(t));
  if (!tokens.length) return;

  const pushMessages = tokens.map((token) => ({
    to: token,
    userId: providerId,
    title,
    body,
    sound: "default" as const,
    priority: "high" as const,
    data: {
      type: "job.match.digest",
      notificationId: notification?.id ?? null,
    },
  }));

  await sendExpoPushDep(pushMessages, { prisma: prismaDep, deadLetter: { enabled: true } });
}

export async function processJobMatchDigest(payload: JobMatchDigestPayload): Promise<void> {
  return processJobMatchDigestWithDeps({ prisma, sendExpoPush, payload });
}
