import test from "node:test";
import assert from "node:assert/strict";
import { computeJobMatchScore } from "./jobMatchRanking";

test("computeJobMatchScore boosts PRO tier", () => {
  const base = {
    jobZip: "10001",
    jobLocation: "New York, NY 10001",
    providerFeaturedZips: [] as string[],
    providerLocation: "New York, NY 10001",
    providerAvgRating: 4.8,
    providerRatingCount: 50,
    providerStats: { medianResponseTimeSeconds30d: 120 },
    providerVerificationBadge: false,
    distanceScoreOverride: 1,
  };

  const free = computeJobMatchScore({ ...base, subscriptionTier: "FREE" });
  const pro = computeJobMatchScore({ ...base, subscriptionTier: "PRO" });

  assert.ok(pro > free);
});

test("computeJobMatchScore penalizes slow response time", () => {
  const base = {
    jobZip: "10001",
    jobLocation: "New York, NY 10001",
    providerFeaturedZips: [],
    providerLocation: "New York, NY 10001",
    providerAvgRating: 4.8,
    providerRatingCount: 50,
    subscriptionTier: "FREE" as const,
    distanceScoreOverride: 1,
  };

  const good = computeJobMatchScore({
    ...base,
    providerStats: { medianResponseTimeSeconds30d: 60 },
  });

  const bad = computeJobMatchScore({
    ...base,
    providerStats: { medianResponseTimeSeconds30d: 60 * 60 },
  });

  assert.ok(good > bad);
});

test("computeJobMatchScore uses distanceScoreOverride", () => {
  const base = {
    jobZip: "10001",
    jobLocation: "New York, NY 10001",
    providerFeaturedZips: [],
    // No ZIP present -> we won't be able to compute miles, so distanceScoreOverride should apply.
    providerLocation: "New York, NY",
    providerAvgRating: 4.8,
    providerRatingCount: 50,
    providerStats: { medianResponseTimeSeconds30d: 120 },
    subscriptionTier: "FREE" as const,
  };

  const close = computeJobMatchScore({ ...base, distanceScoreOverride: 1 });
  const far = computeJobMatchScore({ ...base, distanceScoreOverride: 0 });

  assert.ok(close > far);
});
