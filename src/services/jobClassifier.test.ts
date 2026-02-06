import test from "node:test";
import assert from "node:assert/strict";

import { classifyJob } from "./jobClassifier";

test("classifyJob detects plumbing + urgent", async () => {
  const out = await classifyJob("My kitchen sink is leaking badly, need help ASAP");

  assert.equal(out.trade, "Plumbing");
  assert.equal(out.category, "Repair");
  assert.equal(out.urgency, "URGENT");
  assert.ok(out.suggestedTags.includes("plumbing"));
  assert.ok(out.suggestedTags.includes("leak"));
});

test("classifyJob defaults to Handyman/General", async () => {
  const out = await classifyJob("Need help with a small home project");
  assert.equal(out.trade, "Handyman");
  assert.equal(out.category, "General");
  assert.equal(out.urgency, "NORMAL");
});
