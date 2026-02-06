import test from "node:test";
import assert from "node:assert/strict";

import { decideMessageModeration, scanMessageRisk } from "./riskScoring";

test("decideMessageModeration blocks contact info", () => {
  const risk = scanMessageRisk("Call me at (555) 555-1234");
  const decision = decideMessageModeration(risk);
  assert.equal(decision.action, "BLOCK");
  assert.ok(decision.reasonCodes.includes("CONTACT_INFO"));
});

test("decideMessageModeration blocks obvious scam keywords", () => {
  const risk = scanMessageRisk("Can you pay with a gift card?");
  const decision = decideMessageModeration(risk);
  assert.equal(decision.action, "BLOCK");
  assert.ok(decision.reasonCodes.includes("BANNED_KEYWORD"));
});

test("decideMessageModeration allows normal messages", () => {
  const risk = scanMessageRisk("Hi! I can come by tomorrow afternoon.");
  const decision = decideMessageModeration(risk);
  assert.deepEqual(decision, { action: "ALLOW" });
});

test("decideMessageModeration does not block repeated-message signals alone", () => {
  const decision = decideMessageModeration({
    totalScore: 50,
    signals: [{ code: "REPEATED_MESSAGE", score: 50, detail: "3 repeats" }],
  });
  assert.deepEqual(decision, { action: "ALLOW" });
});
