export type SavedSearchLike = {
  categories: string[];
  radiusMiles: number;
  zipCode: string;
  minBudget: number | null;
  maxBudget: number | null;
};

function normalize(s: string) {
  return s.trim().toLowerCase();
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function categoriesMatch(input: {
  jobCategory: string | null | undefined;
  savedCategories: string[] | null | undefined;
}): boolean {
  const job = normalize(String(input.jobCategory ?? ""));
  if (!job) return false;

  const cats = Array.isArray(input.savedCategories) ? input.savedCategories : [];
  return cats.some((c) => normalize(String(c)) === job);
}

export function budgetsOverlap(input: {
  jobMin: number | null | undefined;
  jobMax: number | null | undefined;
  savedMin: number | null | undefined;
  savedMax: number | null | undefined;
}): boolean {
  const jobMin = typeof input.jobMin === "number" ? input.jobMin : null;
  const jobMax = typeof input.jobMax === "number" ? input.jobMax : null;
  const savedMin = typeof input.savedMin === "number" ? input.savedMin : null;
  const savedMax = typeof input.savedMax === "number" ? input.savedMax : null;

  // If job doesn't provide budgets, don't exclude it.
  if (jobMin == null && jobMax == null) return true;

  // If search doesn't provide budgets, don't exclude it.
  if (savedMin == null && savedMax == null) return true;

  const effectiveJobMin = jobMin ?? jobMax ?? 0;
  const effectiveJobMax = jobMax ?? jobMin ?? 0;

  const effectiveSavedMin = savedMin ?? savedMax ?? 0;
  const effectiveSavedMax = savedMax ?? savedMin ?? 0;

  if (effectiveJobMin > effectiveJobMax) return true;
  if (effectiveSavedMin > effectiveSavedMax) return true;

  // Overlap test (inclusive)
  return effectiveJobMax >= effectiveSavedMin && effectiveJobMin <= effectiveSavedMax;
}

export function computeDistanceScore(distanceMiles: number | null, radiusMiles: number): number {
  const r = Number(radiusMiles);
  if (!Number.isFinite(r) || r <= 0) return distanceMiles === 0 ? 1 : 0;
  if (distanceMiles == null || !Number.isFinite(distanceMiles)) return 0;
  if (distanceMiles > r) return 0;
  return clamp01(1 - distanceMiles / r);
}

export function matchSavedSearchToJob(input: {
  jobCategory: string | null | undefined;
  jobZip: string | null | undefined;
  jobBudgetMin: number | null | undefined;
  jobBudgetMax: number | null | undefined;
  search: SavedSearchLike;
  getDistanceMiles: (zipA: string, zipB: string) => number | null;
}): {
  matched: boolean;
  distanceMiles: number | null;
  distanceScore: number;
} {
  if (!categoriesMatch({ jobCategory: input.jobCategory, savedCategories: input.search.categories })) {
    return { matched: false, distanceMiles: null, distanceScore: 0 };
  }

  if (
    !budgetsOverlap({
      jobMin: input.jobBudgetMin,
      jobMax: input.jobBudgetMax,
      savedMin: input.search.minBudget,
      savedMax: input.search.maxBudget,
    })
  ) {
    return { matched: false, distanceMiles: null, distanceScore: 0 };
  }

  const jobZip = String(input.jobZip ?? "").trim();
  const searchZip = String(input.search.zipCode ?? "").trim();
  if (!/^\d{5}$/.test(jobZip) || !/^\d{5}$/.test(searchZip)) {
    return { matched: false, distanceMiles: null, distanceScore: 0 };
  }

  let distanceMiles = 0;
  if (jobZip !== searchZip) {
    const d = input.getDistanceMiles(searchZip, jobZip);
    if (typeof d !== "number" || !Number.isFinite(d)) {
      return { matched: false, distanceMiles: null, distanceScore: 0 };
    }
    distanceMiles = d;
  }

  const distanceScore = computeDistanceScore(distanceMiles, input.search.radiusMiles);
  if (distanceScore <= 0) {
    return { matched: false, distanceMiles, distanceScore };
  }

  return { matched: true, distanceMiles, distanceScore };
}
