import test from "node:test";
import assert from "node:assert/strict";

import { __testOnly } from "./worker";

test("background jobs are dead-lettered at max attempts (and alert only once)", async () => {
  let updateManyCalls = 0;
  let lastUpdateManyArgs: any = null;

  const prisma = {
    backgroundJob: {
      updateMany: async (args: any) => {
        updateManyCalls += 1;
        lastUpdateManyArgs = args;
        return { count: updateManyCalls === 1 ? 1 : 0 };
      },
    },
  };

  const errorLogs: any[] = [];
  const logger = {
    error: (...args: any[]) => {
      errorLogs.push(args);
    },
  };

  const fixedNow = new Date("2026-01-01T00:00:00.000Z");

  await __testOnly.markFailure(77, 2, 3, new Error("boom"), "worker-1", {
    prisma,
    now: () => fixedNow,
    captureMessage: () => false,
    logger: logger as any,
  });

  assert.equal(errorLogs.length, 1);
  assert.ok(lastUpdateManyArgs);
  assert.equal(lastUpdateManyArgs.where.id, 77);
  assert.equal(lastUpdateManyArgs.data.status, "DEAD");
  assert.equal(lastUpdateManyArgs.data.attempts, 3);
  assert.equal(lastUpdateManyArgs.data.lastAttemptAt.toISOString(), fixedNow.toISOString());

  await __testOnly.markFailure(77, 2, 3, new Error("boom"), "worker-1", {
    prisma,
    now: () => fixedNow,
    captureMessage: () => false,
    logger: logger as any,
  });

  assert.equal(errorLogs.length, 1);
});
