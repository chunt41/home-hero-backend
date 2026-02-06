import type { SubscriptionTier } from "@prisma/client";

export type ProviderDiscoveryRankingBreakdown = {
  baseScore: number;
  tierBoost: number;
  featuredBoost: number;
  finalScore: number;
};

export function computeProviderDiscoveryBaseScore(params: {
  avgRating: number | null | undefined;
  ratingCount: number | null | undefined;
  jobsCompleted30d?: number | null | undefined;
  cancellationRate30d?: number | null | undefined;
  disputeRate30d?: number | null | undefined;
  reportRate30d?: number | null | undefined;
}): number {
  const avgRating = Number(params.avgRating ?? 0);
  const ratingCount = Number(params.ratingCount ?? 0);
  const jobsCompleted30d = Number(params.jobsCompleted30d ?? 0);

  const cancellationRate30d = Number(params.cancellationRate30d ?? 0);
  const disputeRate30d = Number(params.disputeRate30d ?? 0);
  const reportRate30d = Number(params.reportRate30d ?? 0);

  const safeRating = Number.isFinite(avgRating) ? Math.max(0, Math.min(5, avgRating)) : 0;
  const safeCount = Number.isFinite(ratingCount) ? Math.max(0, Math.min(999_999, Math.floor(ratingCount))) : 0;
  const safeJobs30d = Number.isFinite(jobsCompleted30d) ? Math.max(0, Math.min(99_999, Math.floor(jobsCompleted30d))) : 0;

  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const cancel = clamp01(cancellationRate30d);
  const dispute = clamp01(disputeRate30d);
  const report = clamp01(reportRate30d);

  // Rating dominates, then rating volume, then recent activity.
  const ratingKey = Math.round(safeRating * 1000); // 0..5000
  const rawBase = ratingKey * 1_000_000 + safeCount + safeJobs30d * 100;

  // Penalize poor reliability (still deterministic + explainable).
  const penalty = cancel * 0.25 + dispute * 0.35 + report * 0.2;
  const reliabilityMult = Math.max(0.6, 1 - penalty);

  return Math.round(rawBase * reliabilityMult);
}

export function computeProviderDiscoveryRanking(params: {
  avgRating: number | null | undefined;
  ratingCount: number | null | undefined;
  jobsCompleted30d?: number | null | undefined;
  cancellationRate30d?: number | null | undefined;
  disputeRate30d?: number | null | undefined;
  reportRate30d?: number | null | undefined;
  subscriptionTier: SubscriptionTier | null | undefined;
  isFeaturedForZip: boolean;
}): ProviderDiscoveryRankingBreakdown {
  const baseScore = computeProviderDiscoveryBaseScore({
    avgRating: params.avgRating,
    ratingCount: params.ratingCount,
    jobsCompleted30d: params.jobsCompleted30d,
    cancellationRate30d: params.cancellationRate30d,
    disputeRate30d: params.disputeRate30d,
    reportRate30d: params.reportRate30d,
  });

  // Ranking multipliers (kept simple + explainable).
  const tierBoost = params.subscriptionTier === "PRO" ? 1.15 : 1.0;
  const featuredBoost = params.isFeaturedForZip ? 1.25 : 1.0;

  const finalScore = baseScore * tierBoost * featuredBoost;

  return {
    baseScore,
    tierBoost,
    featuredBoost,
    finalScore,
  };
}

export function normalizeZipForBoost(input: {
  zip?: string | null | undefined;
  location?: string | null | undefined;
}): string | null {
  const fromZip = String(input.zip ?? "").trim();
  if (/^\d{5}$/.test(fromZip)) return fromZip;

  const location = String(input.location ?? "").trim();
  if (/^\d{5}$/.test(location)) return location;

  const match = location.match(/\b(\d{5})\b/);
  return match ? match[1] : null;
}
