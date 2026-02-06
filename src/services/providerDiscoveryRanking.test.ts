import test from "node:test";
import assert from "node:assert/strict";

import {
  computeProviderDiscoveryRanking,
  computeProviderDiscoveryBaseScore,
  normalizeZipForBoost,
} from "./providerDiscoveryRanking";

test("computeProviderDiscoveryBaseScore preserves rating-first ordering", () => {
  const a = computeProviderDiscoveryBaseScore({ avgRating: 4.9, ratingCount: 1 });
  const b = computeProviderDiscoveryBaseScore({ avgRating: 4.8, ratingCount: 500 });
  assert.ok(a > b);
});

test("computeProviderDiscoveryBaseScore uses ratingCount as tie-break", () => {
  const a = computeProviderDiscoveryBaseScore({ avgRating: 4.5, ratingCount: 10 });
  const b = computeProviderDiscoveryBaseScore({ avgRating: 4.5, ratingCount: 11 });
  assert.ok(b > a);
});

test("computeProviderDiscoveryRanking boosts PRO tier", () => {
  const free = computeProviderDiscoveryRanking({
    avgRating: 5,
    ratingCount: 10,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
  });

  const pro = computeProviderDiscoveryRanking({
    avgRating: 5,
    ratingCount: 10,
    subscriptionTier: "PRO",
    isFeaturedForZip: false,
  });

  assert.equal(free.baseScore, pro.baseScore);
  assert.equal(free.featuredBoost, 1.0);
  assert.equal(pro.tierBoost, 1.15);
  assert.ok(pro.finalScore > free.finalScore);
});

test("computeProviderDiscoveryRanking boosts featured zip matches", () => {
  const normal = computeProviderDiscoveryRanking({
    avgRating: 4.9,
    ratingCount: 30,
    subscriptionTier: "FREE",
    isFeaturedForZip: false,
  });

  const featured = computeProviderDiscoveryRanking({
    avgRating: 4.9,
    ratingCount: 30,
    subscriptionTier: "FREE",
    isFeaturedForZip: true,
  });

  assert.equal(featured.featuredBoost, 1.25);
  assert.ok(featured.finalScore > normal.finalScore);
});

test("normalizeZipForBoost prefers explicit zip param", () => {
  assert.equal(normalizeZipForBoost({ zip: "12345", location: "Seattle" }), "12345");
});

test("normalizeZipForBoost extracts zip from location", () => {
  assert.equal(normalizeZipForBoost({ location: "Seattle, WA 98101" }), "98101");
  assert.equal(normalizeZipForBoost({ location: "98101" }), "98101");
});
