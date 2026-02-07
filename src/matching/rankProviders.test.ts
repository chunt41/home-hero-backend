import test from "node:test";
import assert from "node:assert/strict";

import { rankProvider } from "./rankProviders";

test("rankProvider is deterministic", () => {
  const a = rankProvider({
    distanceMiles: 12,
    avgRating: 4.8,
    ratingCount: 120,
    medianResponseTimeSeconds30d: 3 * 3600,
    subscriptionTier: "BASIC",
    isFeaturedForZip: true,
    verificationBadge: true,
  });

  const b = rankProvider({
    distanceMiles: 12,
    avgRating: 4.8,
    ratingCount: 120,
    medianResponseTimeSeconds30d: 3 * 3600,
    subscriptionTier: "BASIC",
    isFeaturedForZip: true,
    verificationBadge: true,
  });

  assert.deepEqual(a, b);
});

test("rankProvider: PRO helps but does not dominate", () => {
  const greatFree = rankProvider({
    distanceMiles: 5,
    avgRating: 4.95,
    ratingCount: 250,
    medianResponseTimeSeconds30d: 2 * 3600,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
    verificationBadge: false,
  });

  const mediocrePro = rankProvider({
    distanceMiles: 5,
    avgRating: 4.2,
    ratingCount: 12,
    medianResponseTimeSeconds30d: 2 * 3600,
    subscriptionTier: "PRO",
    isFeaturedForZip: false,
    verificationBadge: false,
  });

  assert.ok(greatFree.finalScore > mediocrePro.finalScore);
});

test("rankProvider penalizes distance and response time", () => {
  const closeFast = rankProvider({
    distanceMiles: 2,
    avgRating: 4.7,
    ratingCount: 50,
    medianResponseTimeSeconds30d: 1 * 3600,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
    verificationBadge: false,
  });

  const farSlow = rankProvider({
    distanceMiles: 40,
    avgRating: 4.7,
    ratingCount: 50,
    medianResponseTimeSeconds30d: 48 * 3600,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
    verificationBadge: false,
  });

  assert.ok(closeFast.finalScore > farSlow.finalScore);
});

test("rankProvider boosts featured zip + verification badge", () => {
  const base = rankProvider({
    distanceMiles: 10,
    avgRating: 4.8,
    ratingCount: 80,
    medianResponseTimeSeconds30d: 6 * 3600,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
    verificationBadge: false,
  });

  const boosted = rankProvider({
    distanceMiles: 10,
    avgRating: 4.8,
    ratingCount: 80,
    medianResponseTimeSeconds30d: 6 * 3600,
    subscriptionTier: "FREE",
    isFeaturedForZip: true,
    verificationBadge: true,
  });

  assert.ok(boosted.finalScore > base.finalScore);
  assert.equal(boosted.featuredBoost, 1.15);
  assert.equal(boosted.verifiedBoost, 1.05);
});
