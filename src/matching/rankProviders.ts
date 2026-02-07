import type { SubscriptionTier } from "@prisma/client";

export type ProviderRankingBreakdown = {
  baseScore: number;
  distanceScore: number;
  ratingScore: number;
  responseScore: number;
  tierBoost: number;
  featuredBoost: number;
  verifiedBoost: number;
  finalScore: number;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function extractZip5(input: string | null | undefined): string | null {
  const s = String(input ?? "");
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

function normalizeTier(tier: unknown): SubscriptionTier {
  const t = String(tier ?? "").toUpperCase();
  if (t === "PRO") return "PRO";
  if (t === "BASIC") return "BASIC";
  return "FREE";
}

export function computeDistanceScoreFromMiles(distanceMiles: number | null | undefined): number {
  if (typeof distanceMiles !== "number" || !Number.isFinite(distanceMiles) || distanceMiles < 0) {
    // Neutral when unknown.
    return 0.5;
  }

  // Simple, explainable falloff:
  // 0mi => 1.0
  // 25mi => 0.5
  // 50mi+ => 0.0
  const score = 1 - distanceMiles / 50;
  return clamp01(score);
}

export function computeResponseScoreFromMedianSeconds(medianSeconds: number | null | undefined): number {
  if (typeof medianSeconds !== "number" || !Number.isFinite(medianSeconds) || medianSeconds <= 0) {
    // Neutral when unknown.
    return 0.5;
  }

  // Convert to hours and apply a smooth penalty.
  // 1h => ~0.92, 6h => ~0.73, 24h => ~0.52, 72h => ~0.35.
  const hours = medianSeconds / 3600;
  const denom = Math.log10(1 + 72);
  const scaled = Math.log10(1 + Math.max(0, hours)) / denom;
  const score = 1 - 0.65 * clamp01(scaled);

  // Don’t let response time fully zero-out ranking.
  return Math.max(0.25, clamp01(score));
}

export function computeRatingScore(params: {
  avgRating: number | null | undefined;
  ratingCount: number | null | undefined;
}): number {
  const avg = Number(params.avgRating ?? 0);
  const count = Number(params.ratingCount ?? 0);

  const safeAvg = Number.isFinite(avg) ? Math.max(0, Math.min(5, avg)) : 0;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.min(999_999, Math.floor(count))) : 0;

  // Bayesian shrinkage towards a reasonable marketplace prior.
  // This makes the result more stable and discourages tiny-sample domination.
  const priorMean = 4.2;
  const priorWeight = 10;
  const adjusted = (safeAvg * safeCount + priorMean * priorWeight) / (safeCount + priorWeight);

  // Slightly reward review volume, but keep it bounded.
  const volumeFactor = clamp01(Math.log10(1 + safeCount) / 2); // ~0..1 by 100 reviews
  const score = (adjusted / 5) * (0.85 + 0.15 * volumeFactor);
  return clamp01(score);
}

export function rankProvider(input: {
  // Prefer distanceScore (0..1) if the caller already computed it.
  distanceScore?: number | null;
  distanceMiles?: number | null;

  avgRating: number | null | undefined;
  ratingCount: number | null | undefined;
  medianResponseTimeSeconds30d?: number | null | undefined;

  subscriptionTier: SubscriptionTier | string | null | undefined;

  isFeaturedForZip: boolean;
  verificationBadge: boolean;
}): ProviderRankingBreakdown {
  const ratingScore = computeRatingScore({
    avgRating: input.avgRating,
    ratingCount: input.ratingCount,
  });

  const distanceScore =
    typeof input.distanceScore === "number" && Number.isFinite(input.distanceScore)
      ? clamp01(input.distanceScore)
      : computeDistanceScoreFromMiles(input.distanceMiles);

  const responseScore = computeResponseScoreFromMedianSeconds(input.medianResponseTimeSeconds30d);

  // Weighted base score (0..1000). Rating dominates; distance/response matter but don’t overwhelm.
  const baseScoreFloat = 1000 * (0.68 * ratingScore + 0.18 * responseScore + 0.14 * distanceScore);
  const baseScore = Math.round(baseScoreFloat);

  const tier = normalizeTier(input.subscriptionTier);

  // Keep boosts modest so PRO improves placement without guaranteeing #1.
  const tierBoost = tier === "PRO" ? 1.12 : tier === "BASIC" ? 1.06 : 1.0;
  const featuredBoost = input.isFeaturedForZip ? 1.15 : 1.0;
  const verifiedBoost = input.verificationBadge ? 1.05 : 1.0;

  const finalScore = baseScore * tierBoost * featuredBoost * verifiedBoost;

  return {
    baseScore,
    distanceScore,
    ratingScore,
    responseScore,
    tierBoost,
    featuredBoost,
    verifiedBoost,
    finalScore,
  };
}
