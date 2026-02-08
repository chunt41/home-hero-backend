import { prisma } from "../prisma";
import { BackgroundJobStatus } from "@prisma/client";
import { isExpoPushToken, sendExpoPush } from "./expoPush";
import { getNotificationPreferencesMap, isKindEnabled, normalizePreference, shouldSendNotification } from "./notificationPreferences";
import zipcodes from "zipcodes";
import { matchSavedSearchToJob } from "./savedSearchMatcher";
import { computeJobMatchScore, extractZip } from "./jobMatchRanking";

type JobMatchPayload = {
  jobId: number;
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function isMissingTableOrRelationError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "");
  return (/relation/i.test(msg) || /table/i.test(msg)) && /does not exist/i.test(msg);
}

async function ensureJobMatchDigestScheduled(params: {
  prisma: typeof prisma;
  providerId: number;
  runAt: Date;
  now: Date;
}) {
  const { prisma: prismaDep, providerId, runAt, now } = params;

  try {
    const existing = await prismaDep.backgroundJob.findFirst({
      where: {
        type: "JOB_MATCH_DIGEST",
        status: { in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.PROCESSING] },
        payload: {
          path: ["providerId"],
          equals: providerId,
        } as any,
      },
      orderBy: [{ runAt: "asc" }, { id: "asc" }],
      select: { id: true, runAt: true, status: true },
    });

    if (existing) {
      if (existing.status === BackgroundJobStatus.PROCESSING) return;
      if (existing.runAt.getTime() <= runAt.getTime()) return;

      await prismaDep.backgroundJob.update({
        where: { id: existing.id },
        data: {
          runAt,
          status: BackgroundJobStatus.PENDING,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      return;
    }

    await prismaDep.backgroundJob.create({
      data: {
        type: "JOB_MATCH_DIGEST",
        payload: { providerId },
        runAt: runAt.getTime() < now.getTime() ? now : runAt,
        maxAttempts: 8,
      },
    });
  } catch (err) {
    if (isMissingTableOrRelationError(err)) return;
    throw err;
  }
}

function clampIntervalMinutes(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  return Math.max(5, Math.min(1440, Math.floor(n)));
}

export async function processJobMatchNotifyWithDeps(deps: {
  prisma: typeof prisma;
  sendExpoPush: typeof sendExpoPush;
  payload: JobMatchPayload;
  now?: Date;
}): Promise<void> {
  const prismaDep = deps.prisma;
  const sendExpoPushDep = deps.sendExpoPush;
  const notifyNow = deps.now ?? new Date();

  const jobId = Number(deps.payload?.jobId);
  if (!Number.isFinite(jobId)) {
    throw new Error("JOB_MATCH_NOTIFY missing jobId");
  }

  const job = await prismaDep.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      location: true,
      category: true,
      budgetMin: true,
      budgetMax: true,
      consumerId: true,
      isHidden: true,
      createdAt: true,
    },
  });

  if (!job) return;
  if (job.isHidden) return;

  const topN = Number(process.env.MATCH_NOTIFY_TOP_N ?? 25);

  const jobCategory = (job.category ?? "").trim();
  const jobCategoryNorm = normalize(jobCategory);
  const jobZip = extractZip(job.location ?? null);

  const providerWindowMinutes = Number(process.env.MATCH_NOTIFY_PROVIDER_WINDOW_MINUTES ?? 60);
  const providerWindowMax = Number(process.env.MATCH_NOTIFY_PROVIDER_WINDOW_MAX ?? 5);

  const jobBudgetMin = typeof job.budgetMin === "number" ? job.budgetMin : null;
  const jobBudgetMax = typeof job.budgetMax === "number" ? job.budgetMax : null;

  type ProviderRow = {
    id: number;
    location: string | null;
    providerProfile: {
      rating: number | null;
      reviewCount: number | null;
      featuredZipCodes: string[];
      verificationBadge: boolean;
    } | null;
    providerEntitlement: {
      verificationBadge: boolean;
    } | null;
    providerStats: {
      jobsCompleted30d: number | null;
      cancellationRate30d: number | null;
      disputeRate30d: number | null;
      reportRate30d: number | null;
      medianResponseTimeSeconds30d: number | null;
    } | null;
    subscription: { tier: string | null } | null;
    pushTokens: { token: string; platform: string | null }[];
  };

  const maxTopN = Math.max(1, Math.min(100, topN));

  // Preferred path: match against enabled saved searches.
  // If the DB doesn't have the new table yet, or job lacks a ZIP/category, fall back to legacy matching.
  let scored:
    | Array<{ provider: ProviderRow; score: number; matchMeta?: { savedSearchId?: number; distanceMiles?: number | null; distanceScore?: number } }>
    | null = null;

  if (jobCategoryNorm && jobZip) {
    try {
      const categoryVariants = Array.from(new Set([jobCategory, jobCategoryNorm].filter(Boolean)));

      const searches = await prismaDep.providerSavedSearch.findMany({
        where: {
          isEnabled: true,
          categories: categoryVariants.length ? { hasSome: categoryVariants } : undefined,
          provider: {
            role: "PROVIDER",
            isSuspended: false,
            blocksReceived: { none: { blockerId: job.consumerId } },
            blocksGiven: { none: { blockedId: job.consumerId } },
          },
        },
        select: {
          id: true,
          providerId: true,
          categories: true,
          radiusMiles: true,
          zipCode: true,
          minBudget: true,
          maxBudget: true,
          provider: {
            select: {
              id: true,
              location: true,
              providerProfile: {
                select: {
                  rating: true,
                  reviewCount: true,
                  featuredZipCodes: true,
                  verificationBadge: true,
                },
              },
              providerEntitlement: {
                select: {
                  verificationBadge: true,
                },
              },
              providerStats: {
                select: {
                  jobsCompleted30d: true,
                  cancellationRate30d: true,
                  disputeRate30d: true,
                  reportRate30d: true,
                  medianResponseTimeSeconds30d: true,
                },
              },
              subscription: {
                select: {
                  tier: true,
                },
              },
              pushTokens: {
                select: {
                  token: true,
                  platform: true,
                },
              },
            },
          },
        },
        take: 5000,
      });

      // We successfully queried saved searches: default to "no matches" (no legacy fallback).
      scored = [];

      if (searches.length) {
        const byProvider = new Map<
          number,
          {
            provider: ProviderRow;
            score: number;
            savedSearchId: number;
            distanceMiles: number | null;
            distanceScore: number;
          }
        >();

        for (const s of searches) {
          const provider = s.provider as ProviderRow;

          const m = matchSavedSearchToJob({
            jobCategory: jobCategoryNorm,
            jobZip,
            jobBudgetMin,
            jobBudgetMax,
            search: {
              categories: s.categories ?? [],
              radiusMiles: s.radiusMiles,
              zipCode: s.zipCode,
              minBudget: s.minBudget ?? null,
              maxBudget: s.maxBudget ?? null,
            },
            getDistanceMiles: (zipA, zipB) => zipcodes.distance(zipA, zipB),
          });

          if (!m.matched) continue;

          const score = computeScore({
            jobZip,
            jobLocation: job.location ?? null,
            providerFeaturedZips: provider.providerProfile?.featuredZipCodes ?? [],
            providerLocation: provider.location ?? null,
            providerRating: provider.providerProfile?.rating ?? null,
            providerReviewCount: provider.providerProfile?.reviewCount ?? null,
            providerVerificationBadge: Boolean(provider.providerEntitlement?.verificationBadge ?? provider.providerProfile?.verificationBadge),
            subscriptionTier: provider.subscription?.tier ?? "FREE",
            providerStats: provider.providerStats ?? null,
            distanceScoreOverride: m.distanceScore,
          });

          const existing = byProvider.get(provider.id);
          if (!existing || score > existing.score) {
            byProvider.set(provider.id, {
              provider,
              score,
              savedSearchId: s.id,
              distanceMiles: m.distanceMiles,
              distanceScore: m.distanceScore,
            });
          }
        }

        scored = Array.from(byProvider.values())
          .map((x) => ({
            provider: x.provider,
            score: x.score,
            matchMeta: {
              savedSearchId: x.savedSearchId,
              distanceMiles: x.distanceMiles,
              distanceScore: x.distanceScore,
            },
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, maxTopN);
      }
    } catch (err) {
      if (!isMissingTableOrRelationError(err)) throw err;
      scored = null;
    }
  }

  // Legacy fallback
  if (!scored) {
    // Pull candidate providers (by category + not-suspended)
    // If job.category is missing, we still try all providers but score will be weak.
    const providers = await prismaDep.user.findMany({
      where: {
        role: "PROVIDER",
        isSuspended: false,
        // Avoid notifying people involved in blocks with the consumer
        blocksReceived: { none: { blockerId: job.consumerId } },
        blocksGiven: { none: { blockedId: job.consumerId } },
        providerProfile: {
          is: jobCategoryNorm
            ? {
                categories: {
                  some: {
                    OR: [
                      { name: { equals: jobCategory, mode: "insensitive" as any } },
                      { slug: { equals: jobCategoryNorm, mode: "insensitive" as any } },
                    ],
                  },
                },
              }
            : {},
        },
      },
      select: {
        id: true,
        location: true,
        providerProfile: {
          select: {
            rating: true,
            reviewCount: true,
            featuredZipCodes: true,
            verificationBadge: true,
          },
        },
        providerEntitlement: {
          select: {
            verificationBadge: true,
          },
        },
        providerStats: {
          select: {
            jobsCompleted30d: true,
            cancellationRate30d: true,
            disputeRate30d: true,
            reportRate30d: true,
            medianResponseTimeSeconds30d: true,
          },
        },
        subscription: {
          select: {
            tier: true,
          },
        },
        pushTokens: {
          select: {
            token: true,
            platform: true,
          },
        },
      },
      take: 2000,
    });

    if (!providers.length) return;

    scored = providers
      .map((p) => {
        const score = computeScore({
          jobZip,
          jobLocation: job.location ?? null,
          providerFeaturedZips: p.providerProfile?.featuredZipCodes ?? [],
          providerLocation: p.location ?? null,
          providerRating: p.providerProfile?.rating ?? null,
          providerReviewCount: p.providerProfile?.reviewCount ?? null,
          providerStats: (p as any).providerStats ?? null,
          providerVerificationBadge: Boolean((p as any).providerEntitlement?.verificationBadge ?? p.providerProfile?.verificationBadge),
          subscriptionTier: p.subscription?.tier ?? "FREE",
        });
        return { provider: p as ProviderRow, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTopN);
  }

  if (!scored.length) return;

  // Dedup: skip already-notified providers
  const already = await prismaDep.jobMatchNotification.findMany({
    where: { jobId, providerId: { in: scored.map((s) => s.provider.id) } },
    select: { providerId: true },
  });
  const alreadySet = new Set(already.map((r) => r.providerId));

  let toNotify = scored.filter((s) => !alreadySet.has(s.provider.id));
  if (!toNotify.length) return;

  // Load preferences once (fail-open if table isn't migrated yet)
  const prefMap = await getNotificationPreferencesMap({
    prisma: prismaDep as any,
    userIds: toNotify.map((s) => s.provider.id),
  });

  // Partition by digest settings and enabled toggles.
  let digestList: typeof toNotify = [];
  let immediateList: typeof toNotify = [];

  for (const item of toNotify) {
    const pref = normalizePreference(prefMap.get(item.provider.id) as any);
    if (!isKindEnabled(pref, "JOB_MATCH")) continue;
    if (pref.matchDeliveryMode === "DIGEST") digestList.push(item);
    else immediateList.push(item);
  }

  // Per-provider notification cap within a rolling window (only applies to immediate sends)
  if (
    immediateList.length &&
    Number.isFinite(providerWindowMinutes) &&
    Number.isFinite(providerWindowMax) &&
    providerWindowMinutes > 0 &&
    providerWindowMax > 0
  ) {
    const windowStart = new Date(notifyNow.getTime() - providerWindowMinutes * 60_000);
    const grouped = await prismaDep.notification.groupBy({
      by: ["userId"],
      where: {
        type: "job.match",
        createdAt: { gte: windowStart },
        userId: { in: immediateList.map((s) => s.provider.id) },
      },
      _count: { _all: true },
    });

    const counts = new Map<number, number>(grouped.map((g) => [g.userId, g._count._all]));
    immediateList = immediateList.filter((s) => (counts.get(s.provider.id) ?? 0) < providerWindowMax);
  }

  // Per-provider match cap within a rolling window for digest accumulation.
  // This reduces unbounded match-row accumulation and keeps digest counts reasonable.
  if (
    digestList.length &&
    Number.isFinite(providerWindowMinutes) &&
    Number.isFinite(providerWindowMax) &&
    providerWindowMinutes > 0 &&
    providerWindowMax > 0
  ) {
    const windowStart = new Date(notifyNow.getTime() - providerWindowMinutes * 60_000);
    const grouped = await prismaDep.jobMatchNotification.groupBy({
      by: ["providerId"],
      where: {
        createdAt: { gte: windowStart },
        providerId: { in: digestList.map((s) => s.provider.id) },
      },
      _count: { _all: true },
    });

    const counts = new Map<number, number>(grouped.map((g) => [g.providerId, g._count._all]));
    digestList = digestList.filter((s) => (counts.get(s.provider.id) ?? 0) < providerWindowMax);
  }

  // Respect quiet hours for immediate sends
  if (immediateList.length) {
    immediateList = immediateList.filter((s) => shouldSendNotification(prefMap.get(s.provider.id), "JOB_MATCH", notifyNow));
  }

  if (!immediateList.length && !digestList.length) return;

  const title = "New job near you";
  const body = job.location ? `${job.title} • ${job.location}` : job.title;

  // Create DB notifications + match rows
  await prismaDep.$transaction(async (tx) => {
    for (const { provider, score, matchMeta } of immediateList) {
      await tx.notification.create({
        data: {
          userId: provider.id,
          type: "job.match",
          content: {
            title,
            body,
            jobId: job.id,
            jobTitle: job.title,
            category: job.category,
            location: job.location,
            score,
            savedSearchId: matchMeta?.savedSearchId,
            distanceMiles: matchMeta?.distanceMiles ?? null,
          },
        },
      });

      await tx.jobMatchNotification.create({
        data: {
          jobId: job.id,
          providerId: provider.id,
          score,
        },
      });
    }

    for (const { provider, score } of digestList) {
      await tx.jobMatchNotification.create({
        data: {
          jobId: job.id,
          providerId: provider.id,
          score,
        },
      });
    }
  });

  // Send push notifications (best-effort)
  const pushMessages = immediateList.flatMap(({ provider }) =>
    (provider.pushTokens ?? [])
      .map((t) => t.token)
      .filter((token) => isExpoPushToken(token))
      .map((token) => ({
        to: token,
        userId: provider.id,
        title,
        body,
        sound: "default" as const,
        priority: "high" as const,
        data: { type: "job.match", jobId: job.id },
      }))
  );

  if (pushMessages.length) {
    await sendExpoPushDep(pushMessages, { prisma: prismaDep, deadLetter: { enabled: true } });
  }

  // Schedule digest send(s) for digest-enabled providers
  if (digestList.length) {
    for (const item of digestList) {
      const pref = normalizePreference(prefMap.get(item.provider.id) as any);
      const intervalMinutes = clampIntervalMinutes(pref.digestIntervalMinutes);
      const last = pref.jobMatchDigestLastSentAt ? new Date(pref.jobMatchDigestLastSentAt) : null;
      const byNow = new Date(notifyNow.getTime() + intervalMinutes * 60_000);
      const byLast = last ? new Date(last.getTime() + intervalMinutes * 60_000) : byNow;
      const runAt = byLast.getTime() > byNow.getTime() ? byLast : byNow;
      await ensureJobMatchDigestScheduled({ prisma: prismaDep, providerId: item.provider.id, runAt, now: notifyNow });
    }
  }
}

export async function processJobMatchNotify(payload: JobMatchPayload): Promise<void> {
  return processJobMatchNotifyWithDeps({ prisma, sendExpoPush, payload });
}

function computeScore(params: {
  jobZip: string | null;
  jobLocation: string | null;
  providerFeaturedZips: string[];
  providerLocation: string | null;
  providerRating: number | null;
  providerReviewCount: number | null;
  providerStats?: {
    jobsCompleted30d: number | null;
    cancellationRate30d: number | null;
    disputeRate30d: number | null;
    reportRate30d: number | null;
    medianResponseTimeSeconds30d: number | null;
  } | null;
  providerVerificationBadge?: boolean;
  subscriptionTier: string | null;
  distanceScoreOverride?: number | null;
}): number {
  return computeJobMatchScore({
    jobZip: params.jobZip,
    jobLocation: params.jobLocation,
    providerFeaturedZips: params.providerFeaturedZips,
    providerLocation: params.providerLocation,
    providerAvgRating: params.providerRating,
    providerRatingCount: params.providerReviewCount,
    providerStats: params.providerStats ?? null,
    providerVerificationBadge: params.providerVerificationBadge ?? false,
    subscriptionTier: (params.subscriptionTier as any) ?? null,
    distanceScoreOverride: params.distanceScoreOverride,
  });
}
