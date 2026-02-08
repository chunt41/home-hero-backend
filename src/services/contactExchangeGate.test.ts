import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOffPlatformRisk,
  computeRiskScoreExcludingOffPlatformVectors,
  jobStatusAllowsOffPlatformContact,
  shouldBypassOffPlatformContactBlock,
} from "./contactExchangeGate";

import { assessTextRisk } from "./riskScoring";

function risk(signals: any[]) {
  const totalScore = signals.reduce((sum, s) => sum + (s.score ?? 0), 0);
  return { totalScore, signals };
}

test("classifyOffPlatformRisk: phone/email is contact-like", () => {
  const r = risk([{ code: "CONTACT_INFO", score: 35, detail: "phone" }]);
  const c = classifyOffPlatformRisk(r as any);
  assert.equal(c.hasContactInfo, true);
  assert.equal(c.hasAnyOffPlatformVector, true);
  assert.deepEqual(c.scamKeywords, []);
});

test("classifyOffPlatformRisk: telegram/whatsapp treated as contact-like", () => {
  const r = risk([
    { code: "BANNED_KEYWORD", score: 25, detail: "telegram" },
    { code: "BANNED_KEYWORD", score: 20, detail: "whatsapp" },
  ]);
  const c = classifyOffPlatformRisk(r as any);
  assert.equal(c.hasAnyOffPlatformVector, true);
  assert.deepEqual(c.offPlatformKeywords.sort(), ["telegram", "whatsapp"]);
  assert.deepEqual(c.scamKeywords, []);
});

test("classifyOffPlatformRisk: payment keywords are scam-like", () => {
  const r = risk([{ code: "BANNED_KEYWORD", score: 50, detail: "western union" }]);
  const c = classifyOffPlatformRisk(r as any);
  assert.equal(c.hasAnyOffPlatformVector, true);
  assert.deepEqual(c.scamKeywords, ["western union"]);
});

test("jobStatusAllowsOffPlatformContact: OPEN blocks, AWARDED+ allows", () => {
  assert.equal(jobStatusAllowsOffPlatformContact("OPEN"), false);
  assert.equal(jobStatusAllowsOffPlatformContact("AWARDED"), true);
  assert.equal(jobStatusAllowsOffPlatformContact("IN_PROGRESS"), true);
  assert.equal(jobStatusAllowsOffPlatformContact("COMPLETED"), true);
  assert.equal(jobStatusAllowsOffPlatformContact("DISPUTED"), true);
  assert.equal(jobStatusAllowsOffPlatformContact("CANCELLED"), true);
});

test("shouldBypassOffPlatformContactBlock: bypasses when job is awarded (includes payment prompts)", () => {
  const risk = assessTextRisk("send me your email and pay with zelle");
  const decision = shouldBypassOffPlatformContactBlock({
    risk,
    jobStatus: "AWARDED",
    contactExchangeApproved: false,
  });
  assert.equal(decision.bypass, true);
  assert.equal(decision.reason, "job_status_awarded_or_later");
});

test("shouldBypassOffPlatformContactBlock: bypasses for awarded job on contact-only", () => {
  const risk = assessTextRisk("call me at 555-222-1111");
  const decision = shouldBypassOffPlatformContactBlock({
    risk,
    jobStatus: "AWARDED",
    contactExchangeApproved: false,
  });
  assert.equal(decision.bypass, true);
  assert.equal(decision.reason, "job_status_awarded_or_later");
});

test("shouldBypassOffPlatformContactBlock: bypasses for approved exchange", () => {
  const risk = assessTextRisk("email me test@example.com");
  const decision = shouldBypassOffPlatformContactBlock({
    risk,
    jobStatus: "OPEN",
    contactExchangeApproved: true,
  });
  assert.equal(decision.bypass, true);
  assert.equal(decision.reason, "contact_exchange_approved");
});

test("computeRiskScoreExcludingOffPlatformVectors strips CONTACT_INFO + all BANNED_KEYWORD", () => {
  const risk = {
    totalScore: 999,
    signals: [
      { code: "CONTACT_INFO", score: 35, detail: "email" },
      { code: "BANNED_KEYWORD", score: 25, detail: "telegram" },
      { code: "REPEATED_MESSAGE", score: 25, detail: "2 repeats" },
    ],
  };

  assert.equal(computeRiskScoreExcludingOffPlatformVectors(risk as any), 25);
});
