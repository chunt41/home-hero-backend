import { prisma } from "../prisma";
import { isExpoPushToken, sendExpoPush } from "./expoPush";
import zipcodes from "zipcodes";
import { matchSavedSearchToJob } from "./savedSearchMatcher";

type JobMatchPayload = {
  jobId: number;
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function extractZip(location: string | null | undefined): string | null {
  if (!location) return null;
  const m = location.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

function subscriptionMultiplier(tier: string | null | undefined): number {
  switch (tier) {
    case "PRO":
      return 1.5;
    case "BASIC":
      return 1.2;
    case "FREE":
    default:
      return 1.0;
  }
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function computeScore(params: {
  jobZip: string | null;
  jobLocation: string | null;
  providerFeaturedZips: string[];
  providerLocation: string | null;
  providerRating: number | null;
  providerReviewCount: number | null;
  subscriptionTier: string | null;
  distanceScoreOverride?: number | null;
}): number {
  const jobZip = params.jobZip;

  let distanceScore = 0.35;
  if (typeof params.distanceScoreOverride === "number" && Number.isFinite(params.distanceScoreOverride)) {
    distanceScore = clamp01(params.distanceScoreOverride);
  } else {
    if (jobZip && Array.isArray(params.providerFeaturedZips) && params.providerFeaturedZips.includes(jobZip)) {
      distanceScore = 1.0;
    } else if (jobZip && params.providerLocation && normalize(params.providerLocation).includes(jobZip)) {
      distanceScore = 0.8;
    } else if (params.jobLocation && params.providerLocation) {
      const jl = normalize(params.jobLocation);
      const pl = normalize(params.providerLocation);
      if (jl && pl && (jl.includes(pl) || pl.includes(jl))) {
        distanceScore = 0.6;
      }
    }
  }

  const rating = typeof params.providerRating === "number" ? params.providerRating : null;
  const ratingScore = clamp01((rating ?? 3.5) / 5);

  const rc = typeof params.providerReviewCount === "number" ? params.providerReviewCount : 0;
  const confidenceBoost = 1 + Math.log10((rc ?? 0) + 1) / 6; // ~1..1.3-ish

  const tierMult = subscriptionMultiplier(params.subscriptionTier ?? "FREE");

  // Weighted blend → then subscription multiplier
  const blended = 0.55 * ratingScore + 0.45 * distanceScore;
  return blended * confidenceBoost * tierMult;
}

function isMissingTableOrRelationError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "");
  return (/relation/i.test(msg) || /table/i.test(msg)) && /does not exist/i.test(msg);
}

export async function processJobMatchNotify(payload: JobMatchPayload): Promise<void> {
  const jobId = Number(payload?.jobId);
  if (!Number.isFinite(jobId)) {
    throw new Error("JOB_MATCH_NOTIFY missing jobId");
  }

  const job = await prisma.job.findUnique({
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

      const searches = await prisma.providerSavedSearch.findMany({
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
            subscriptionTier: provider.subscription?.tier ?? "FREE",
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
    const providers = await prisma.user.findMany({
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
          subscriptionTier: p.subscription?.tier ?? "FREE",
        });
        return { provider: p as ProviderRow, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTopN);
  }

  if (!scored.length) return;

  // Dedup: skip already-notified providers
  const already = await prisma.jobMatchNotification.findMany({
    where: { jobId, providerId: { in: scored.map((s) => s.provider.id) } },
    select: { providerId: true },
  });
  const alreadySet = new Set(already.map((r) => r.providerId));

  let toNotify = scored.filter((s) => !alreadySet.has(s.provider.id));
  if (!toNotify.length) return;

  // Per-provider notification cap within a rolling window
  if (Number.isFinite(providerWindowMinutes) && Number.isFinite(providerWindowMax) && providerWindowMinutes > 0 && providerWindowMax > 0) {
    const windowStart = new Date(Date.now() - providerWindowMinutes * 60_000);
    const grouped = await prisma.notification.groupBy({
      by: ["userId"],
      where: {
        type: "job.match",
        createdAt: { gte: windowStart },
        userId: { in: toNotify.map((s) => s.provider.id) },
      },
      _count: { _all: true },
    });

    const counts = new Map<number, number>(grouped.map((g) => [g.userId, g._count._all]));
    toNotify = toNotify.filter((s) => (counts.get(s.provider.id) ?? 0) < providerWindowMax);
  }

  if (!toNotify.length) return;

  const title = "New job near you";
  const body = job.location ? `${job.title} • ${job.location}` : job.title;

  // Create DB notifications + match rows
  await prisma.$transaction(async (tx) => {
    for (const { provider, score, matchMeta } of toNotify) {
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
  });

  // Send push notifications (best-effort)
  const pushMessages = toNotify
    .flatMap(({ provider }) => provider.pushTokens ?? [])
    .map((t) => t.token)
    .filter((token) => isExpoPushToken(token))
    .map((token) => ({
      to: token,
      title,
      body,
      sound: "default" as const,
      priority: "high" as const,
      data: { type: "job.match", jobId: job.id },
    }));

  if (pushMessages.length) {
    await sendExpoPush(pushMessages);
  }
}
