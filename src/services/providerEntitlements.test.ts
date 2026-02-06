import test from "node:test";
import assert from "node:assert/strict";

import {
  getUsageMonthKey,
  getBaseLeadLimitForTier,
  getLeadEntitlementsFromSubscription,
} from "./providerEntitlements";

test("getUsageMonthKey() uses UTC year-month", () => {
  const d = new Date(Date.UTC(2026, 0, 15, 12, 0, 0)); // 2026-01
  assert.equal(getUsageMonthKey(d), "2026-01");
});

test("getBaseLeadLimitForTier() returns expected defaults", () => {
  assert.equal(getBaseLeadLimitForTier("FREE"), 5);
  assert.equal(getBaseLeadLimitForTier("BASIC"), 100);
  assert.equal(getBaseLeadLimitForTier("PRO"), 1_000_000);
});

test("getLeadEntitlementsFromSubscription() computes remaining with extra credits", () => {
  const ent = getLeadEntitlementsFromSubscription({
    tier: "BASIC",
    usageMonthKey: "2026-02",
    leadsUsedThisMonth: 12,
    extraLeadCreditsThisMonth: 10,
  });

  assert.equal(ent.baseLeadLimitThisMonth, 100);
  assert.equal(ent.remainingLeadsThisMonth, 98);
});

test("getLeadEntitlementsFromSubscription() clamps remaining at 0", () => {
  const ent = getLeadEntitlementsFromSubscription({
    tier: "FREE",
    usageMonthKey: "2026-02",
    leadsUsedThisMonth: 10,
    extraLeadCreditsThisMonth: 0,
  });

  assert.equal(ent.remainingLeadsThisMonth, 0);
});
