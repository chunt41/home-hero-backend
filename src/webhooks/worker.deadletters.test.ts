import test from "node:test";
import assert from "node:assert/strict";

import { __testOnly } from "./worker";

test("webhook deliveries are dead-lettered at max attempts (and alert only once)", async () => {
  let updateManyCalls = 0;
  const prisma = {
    webhookDelivery: {
      updateMany: async (args: any) => {
        updateManyCalls += 1;
        return { count: updateManyCalls === 1 ? 1 : 0 };
      },
      update: async (_args: any) => ({ ok: true }),
    },
  };

  const errorLogs: any[] = [];
  const logger = {
    error: (...args: any[]) => {
      errorLogs.push(args);
    },
  };

  const fixedNow = new Date("2026-01-01T00:00:00.000Z");

  await __testOnly.failAndReschedule(123, 3, "boom", undefined, {
    prisma,
    maxAttempts: 3,
    now: () => fixedNow,
    captureMessage: () => false,
    logger: logger as any,
  });

  assert.equal(errorLogs.length, 1);

  await __testOnly.failAndReschedule(123, 3, "boom", undefined, {
    prisma,
    maxAttempts: 3,
    now: () => fixedNow,
    captureMessage: () => false,
    logger: logger as any,
  });

  assert.equal(errorLogs.length, 1);
});

test("webhook deliveries are rescheduled before max attempts", async () => {
  const updateCalls: any[] = [];
  const prisma = {
    webhookDelivery: {
      updateMany: async (_args: any) => ({ count: 0 }),
      update: async (args: any) => {
        updateCalls.push(args);
        return { ok: true };
      },
    },
  };

  const fixedNow = new Date("2026-01-01T00:00:00.000Z");

  await __testOnly.failAndReschedule(123, 1, "transient", 0, {
    prisma,
    maxAttempts: 3,
    now: () => fixedNow,
    captureMessage: () => false,
    logger: { error: () => {} } as any,
  });

  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].where.id, 123);
  assert.equal(updateCalls[0].data.status, "PENDING");
  assert.equal(updateCalls[0].data.lastAttemptAt.toISOString(), fixedNow.toISOString());
  assert.ok(updateCalls[0].data.nextAttempt instanceof Date);
});
