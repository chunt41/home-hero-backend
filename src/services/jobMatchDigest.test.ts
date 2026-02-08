import test from "node:test";
import assert from "node:assert/strict";

import { processJobMatchDigestWithDeps } from "./jobMatchDigest";
import { RescheduleJobError } from "../jobs/jobErrors";

test("job match digest: quiet hours reschedules send", async () => {
  const prisma: any = {
    notificationPreference: {
      findUnique: async () => ({
        userId: 7,
        jobMatchEnabled: true,
        jobMatchDigestEnabled: true,
        jobMatchDigestIntervalMinutes: 15,
        jobMatchDigestLastSentAt: null,
        bidEnabled: true,
        messageEnabled: true,
        quietHoursStart: "09:00",
        quietHoursEnd: "17:00",
        timezone: "UTC",
      }),
    },
    jobMatchNotification: {
      count: async () => {
        throw new Error("count should not be called during quiet hours");
      },
    },
  };

  await assert.rejects(
    () =>
      processJobMatchDigestWithDeps({
        prisma,
        sendExpoPush: async () => {},
        now: new Date("2025-01-01T12:00:00Z"),
        payload: { providerId: 7 },
      }),
    (err: any) => {
      assert.ok(err instanceof RescheduleJobError);
      assert.ok(err.runAt instanceof Date);
      assert.ok(err.runAt.getTime() > new Date("2025-01-01T12:00:00Z").getTime());
      return true;
    }
  );
});

test("job match digest: batches into one notification and push", async () => {
  const calls: any = { push: [], notifCreate: [], updateMany: [], prefUpdate: [] };

  const prisma: any = {
    notificationPreference: {
      findUnique: async () => ({
        userId: 7,
        jobMatchEnabled: true,
        jobMatchDigestEnabled: true,
        jobMatchDigestIntervalMinutes: 15,
        jobMatchDigestLastSentAt: null,
        bidEnabled: true,
        messageEnabled: true,
        quietHoursStart: null,
        quietHoursEnd: null,
        timezone: "UTC",
      }),
      update: async (args: any) => {
        calls.prefUpdate.push(args);
        return { userId: 7 };
      },
    },
    jobMatchNotification: {
      count: async () => 4,
      findMany: async () => [
        {
          jobId: 101,
          score: 0.99,
          createdAt: new Date("2025-01-01T00:00:00Z"),
          job: { id: 101, title: "Fix sink", location: "90210", category: "Plumbing" },
        },
        {
          jobId: 102,
          score: 0.5,
          createdAt: new Date("2025-01-01T00:01:00Z"),
          job: { id: 102, title: "Paint fence", location: "90210", category: "Painting" },
        },
      ],
      updateMany: async (args: any) => {
        calls.updateMany.push(args);
        return { count: 4 };
      },
    },
    notification: {
      create: async (args: any) => {
        calls.notifCreate.push(args);
        return { id: 99 };
      },
    },
    user: {
      findUnique: async () => ({
        pushTokens: [{ token: "ExponentPushToken[ok]", platform: "ios" }],
      }),
    },
  };

  await processJobMatchDigestWithDeps({
    prisma,
    sendExpoPush: async (messages: any) => {
      calls.push.push(messages);
    },
    now: new Date("2025-01-01T12:00:00Z"),
    payload: { providerId: 7 },
  });

  assert.equal(calls.notifCreate.length, 1);
  assert.equal(calls.updateMany.length, 1);
  assert.equal(calls.prefUpdate.length, 1);
  assert.equal(calls.push.length, 1);

  const pushMsgs = calls.push[0];
  assert.equal(pushMsgs.length, 1);
  assert.equal(pushMsgs[0].data.type, "job.match.digest");
});
