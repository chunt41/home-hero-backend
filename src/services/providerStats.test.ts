import test from "node:test";
import assert from "node:assert/strict";

import { computeMedianSeconds, computeProviderStatsSnapshot, getNextDailyRunAtUtc } from "./providerStats";

test("computeMedianSeconds returns null for empty", () => {
  assert.equal(computeMedianSeconds([]), null);
});

test("computeMedianSeconds computes median (odd/even)", () => {
  assert.equal(computeMedianSeconds([3, 1, 2]), 2);
  assert.equal(computeMedianSeconds([10, 20, 30, 40]), 25);
});

test("computeProviderStatsSnapshot computes rates and clamps", () => {
  const stats = computeProviderStatsSnapshot({
    avgRating: 4.5,
    ratingCount: 2,
    jobsCompletedAllTime: 99,
    jobsCompleted30d: 3,
    jobsFinished30d: 4,
    jobsCancelled30d: 1,
    responseTimesSeconds30d: [10, 20, 30],
    disputes30d: 1,
    reports30d: 0,
  });

  assert.equal(stats.avgRating, 4.5);
  assert.equal(stats.ratingCount, 2);
  assert.equal(stats.jobsCompletedAllTime, 99);
  assert.equal(stats.jobsCompleted30d, 3);
  assert.equal(stats.medianResponseTimeSeconds30d, 20);

  assert.equal(stats.cancellationRate30d, 0.25);
  assert.equal(stats.disputeRate30d, 0.25);
  assert.equal(stats.reportRate30d, 0);
});

test("getNextDailyRunAtUtc schedules next run", () => {
  const now = new Date(Date.UTC(2026, 1, 6, 10, 0, 0));
  const next = getNextDailyRunAtUtc({ now, hourUtc: 4 });
  assert.ok(next.getTime() > now.getTime());
  assert.equal(next.getUTCHours(), 4);
});
