import type { SubscriptionTier } from "@prisma/client";
import { extractZip5, rankProvider } from "../matching/rankProviders";
import zipcodes from "zipcodes";

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function extractZip(location: string | null | undefined): string | null {
  if (!location) return null;
  const m = location.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

export function computeJobMatchScore(params: {
  jobZip: string | null;
  jobLocation: string | null;
  providerFeaturedZips: string[];
  providerLocation: string | null;
  providerAvgRating: number | null;
  providerRatingCount: number | null;
  providerStats?: {
    jobsCompleted30d?: number | null;
    cancellationRate30d?: number | null;
    disputeRate30d?: number | null;
    reportRate30d?: number | null;
    medianResponseTimeSeconds30d?: number | null;
  } | null;
  providerVerificationBadge?: boolean | null;
  subscriptionTier: SubscriptionTier | null;
  distanceScoreOverride?: number | null;
}): number {
  const jobZip = params.jobZip;

  // Distance / proximity score (0..1)
  let distanceScore = 0.35;
  if (typeof params.distanceScoreOverride === "number" && Number.isFinite(params.distanceScoreOverride)) {
    distanceScore = clamp01(params.distanceScoreOverride);
  } else {
    if (jobZip && Array.isArray(params.providerFeaturedZips) && params.providerFeaturedZips.includes(jobZip)) {
      distanceScore = 1.0;
    } else if (jobZip && params.providerLocation && String(params.providerLocation).includes(jobZip)) {
      distanceScore = 0.8;
    } else if (params.jobLocation && params.providerLocation) {
      const jl = String(params.jobLocation).trim().toLowerCase();
      const pl = String(params.providerLocation).trim().toLowerCase();
      if (jl && pl && (jl.includes(pl) || pl.includes(jl))) {
        distanceScore = 0.6;
      }
    }
  }

  const isFeaturedForZip = !!(jobZip && params.providerFeaturedZips?.includes(jobZip));

  const boostedZip = extractZip(jobZip);
  const providerZip = extractZip5(params.providerLocation ?? null);
  const distanceMiles =
    boostedZip && providerZip
      ? boostedZip === providerZip
        ? 0
        : (zipcodes.distance(boostedZip, providerZip) as number | null)
      : null;

  const ranked = rankProvider({
    distanceMiles,
    avgRating: params.providerAvgRating,
    ratingCount: params.providerRatingCount,
    medianResponseTimeSeconds30d: params.providerStats?.medianResponseTimeSeconds30d ?? null,
    subscriptionTier: params.subscriptionTier,
    isFeaturedForZip,
    verificationBadge: Boolean(params.providerVerificationBadge),
  });

  // Blend in distance without letting it dominate tier/rating.
  // Range: 0.7..1.0
  const distanceMult = 0.7 + 0.3 * clamp01(distanceScore);

  // If we have real miles, `rankProvider()` already applied distance.
  // Otherwise, keep the existing heuristic distance blending for continuity.
  if (distanceMiles == null) return ranked.finalScore * distanceMult;
  return ranked.finalScore;
}
