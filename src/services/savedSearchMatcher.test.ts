import test from "node:test";
import assert from "node:assert/strict";

import { budgetsOverlap, categoriesMatch, computeDistanceScore, matchSavedSearchToJob } from "./savedSearchMatcher";

test("categoriesMatch matches case-insensitive", () => {
  assert.equal(categoriesMatch({ jobCategory: "Plumbing", savedCategories: ["plumbing"] }), true);
  assert.equal(categoriesMatch({ jobCategory: "plumbing", savedCategories: ["Plumbing"] }), true);
  assert.equal(categoriesMatch({ jobCategory: "Electrical", savedCategories: ["Plumbing"] }), false);
});

test("budgetsOverlap is permissive when job budget missing", () => {
  assert.equal(budgetsOverlap({ jobMin: null, jobMax: null, savedMin: 200, savedMax: 500 }), true);
});

test("budgetsOverlap checks inclusive overlap", () => {
  assert.equal(budgetsOverlap({ jobMin: 100, jobMax: 200, savedMin: 200, savedMax: 300 }), true);
  assert.equal(budgetsOverlap({ jobMin: 100, jobMax: 150, savedMin: 200, savedMax: 300 }), false);
});

test("computeDistanceScore clamps and respects radius", () => {
  assert.equal(computeDistanceScore(0, 25), 1);
  assert.equal(computeDistanceScore(25, 25), 0);
  assert.equal(computeDistanceScore(10, 20) > computeDistanceScore(15, 20), true);
  assert.equal(computeDistanceScore(30, 20), 0);
});

test("matchSavedSearchToJob matches when within radius", () => {
  const out = matchSavedSearchToJob({
    jobCategory: "plumbing",
    jobZip: "94105",
    jobBudgetMin: 200,
    jobBudgetMax: 400,
    search: {
      categories: ["Plumbing"],
      radiusMiles: 25,
      zipCode: "94107",
      minBudget: null,
      maxBudget: null,
    },
    getDistanceMiles: () => 5,
  });

  assert.equal(out.matched, true);
  assert.equal(out.distanceMiles, 5);
  assert.ok(out.distanceScore > 0);
});

test("matchSavedSearchToJob rejects when outside radius", () => {
  const out = matchSavedSearchToJob({
    jobCategory: "plumbing",
    jobZip: "94105",
    jobBudgetMin: 200,
    jobBudgetMax: 400,
    search: {
      categories: ["Plumbing"],
      radiusMiles: 10,
      zipCode: "94107",
      minBudget: null,
      maxBudget: null,
    },
    getDistanceMiles: () => 25,
  });

  assert.equal(out.matched, false);
});
