import test from "node:test";
import assert from "node:assert/strict";

import { moderateJobMessageSend } from "./jobMessageSendModeration";
import type { RiskAssessment } from "./riskScoring";

function makeRisk(signals: Array<{ code: any; score: number; detail?: string }>): RiskAssessment {
  return {
    signals: signals as any,
    totalScore: signals.reduce((sum, s) => sum + s.score, 0),
  };
}

test("moderation: blocks contact info pre-award (OPEN)", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => null },
    providerVerification: { findUnique: async () => null },
    securityEvent: { count: async () => 0 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 10, role: "CONSUMER", riskScore: 0 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "OPEN",
    senderId: 10,
    messageText: "Call me at 555-555-5555",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () => makeRisk([{ code: "CONTACT_INFO", score: 35, detail: "phone" }]),
  });

  assert.equal(out.action, "BLOCK");
  assert.equal(out.body.code, "CONTACT_INFO_NOT_ALLOWED");

  assert.equal(calls.userUpdates.length, 1);
  assert.equal(calls.userUpdates[0].data.riskScore.increment, 35);
  assert.ok(calls.events.some((e: any) => e.actionType === "message.blocked"));
});

test("moderation: allows contact info when job is AWARDED+ (bypass)", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => null },
    providerVerification: { findUnique: async () => null },
    securityEvent: { count: async () => 0 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 10, role: "CONSUMER", riskScore: 0 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "AWARDED",
    senderId: 10,
    messageText: "My email is test@example.com",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () => makeRisk([{ code: "CONTACT_INFO", score: 35, detail: "email" }]),
  });

  assert.deepEqual(out, { action: "ALLOW" });
  assert.equal(calls.userUpdates.length, 0);
  assert.ok(calls.events.some((e: any) => e.actionType === "message.offplatform_allowed"));
});

test("moderation: allows telegram/whatsapp when contact exchange approved", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => ({ id: 123 }) },
    providerVerification: { findUnique: async () => null },
    securityEvent: { count: async () => 0 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 20, role: "CONSUMER", riskScore: 0 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "OPEN",
    senderId: 20,
    messageText: "Message me on telegram",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () =>
      makeRisk([{ code: "BANNED_KEYWORD", score: 25, detail: "telegram" }]),
  });

  assert.deepEqual(out, { action: "ALLOW" });
  assert.equal(calls.userUpdates.length, 0);
  assert.ok(calls.events.some((e: any) => e.actionType === "message.offplatform_allowed"));
});

test("moderation: still blocks scam/payment keywords even if awarded or approved", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => ({ id: 123 }) },
    providerVerification: { findUnique: async () => ({ status: "VERIFIED" }) },
    securityEvent: { count: async () => 0 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 99, role: "PROVIDER", riskScore: 0 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "AWARDED",
    senderId: 99,
    messageText: "Pay me on zelle",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () => makeRisk([{ code: "BANNED_KEYWORD", score: 25, detail: "zelle" }]),
  });

  assert.equal(out.action, "BLOCK");
  assert.equal(out.body.code, "MESSAGE_BLOCKED");
  assert.ok(calls.events.some((e: any) => e.actionType === "message.blocked"));
});

test("moderation: provider verified + low risk bypasses contact info", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => null },
    providerVerification: { findUnique: async () => ({ status: "VERIFIED" }) },
    securityEvent: { count: async () => 0 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 99, role: "PROVIDER", riskScore: 10 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "OPEN",
    senderId: 99,
    messageText: "Text me at 555-555-5555",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () => makeRisk([{ code: "CONTACT_INFO", score: 35, detail: "phone" }]),
  });

  assert.deepEqual(out, { action: "ALLOW" });
  assert.equal(calls.userUpdates.length, 0);
  assert.ok(calls.events.some((e: any) => e.actionType === "message.offplatform_allowed"));
});

test("moderation: repeated blocks can trigger restriction", async () => {
  const calls: any = { userUpdates: [], events: [] };

  const prisma = {
    contactExchangeRequest: { findFirst: async () => null },
    providerVerification: { findUnique: async () => null },
    securityEvent: { count: async () => 3 },
    user: {
      update: async (args: any) => {
        calls.userUpdates.push(args);
        return {};
      },
    },
  };

  const req = { user: { userId: 10, role: "CONSUMER", riskScore: 0 } };

  const out = await moderateJobMessageSend({
    prisma,
    req,
    isAdmin: false,
    jobId: 1,
    jobStatus: "OPEN",
    senderId: 10,
    messageText: "Call me at 555-555-5555",
    appealUrl: "https://example.com/appeal",
    logSecurityEvent: async (_req, actionType, payload) => {
      calls.events.push({ actionType, payload });
    },
    assessRepeatedMessageRisk: async () => makeRisk([{ code: "CONTACT_INFO", score: 35, detail: "phone" }]),
  });

  assert.equal(out.action, "RESTRICTED");
  assert.equal(out.status, 403);
  assert.ok(out.restrictedUntil instanceof Date);
  assert.ok(calls.events.some((e: any) => e.actionType === "user.restricted"));
});
