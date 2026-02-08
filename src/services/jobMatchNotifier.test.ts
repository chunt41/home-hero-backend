import test from "node:test";
import assert from "node:assert/strict";

import { processJobMatchNotifyWithDeps } from "./jobMatchNotifier";

async function withEnv(patch: Partial<NodeJS.ProcessEnv>, fn: () => Promise<void> | void) {
  const prev = { ...process.env };
  try {
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.env as any)[k];
    }
    Object.assign(process.env, prev);
  }
}

test("processJobMatchNotify schedules JOB_MATCH_DIGEST for digest-enabled providers", async () => {
  await withEnv(
    {
      MATCH_NOTIFY_PROVIDER_WINDOW_MINUTES: "60",
      MATCH_NOTIFY_PROVIDER_WINDOW_MAX: "5",
    },
    async () => {
      const now = new Date("2026-02-07T12:00:00.000Z");

      const calls: any = {
        push: [],
        txJobMatchCreates: [],
        txNotifCreates: [],
        digestJobCreates: [],
      };

      const prisma: any = {
        job: {
          findUnique: async () => ({
            id: 123,
            title: "Fix sink",
            location: "New York, NY",
            category: null, // force legacy fallback
            budgetMin: 100,
            budgetMax: 200,
            consumerId: 999,
            isHidden: false,
            createdAt: now,
          }),
        },
        providerSavedSearch: {
          findMany: async () => {
            throw new Error("providerSavedSearch should not be called in legacy fallback test");
          },
        },
        user: {
          findMany: async () => [
            {
              id: 200,
              location: "New York, NY",
              providerProfile: { rating: 5, reviewCount: 10, featuredZipCodes: [], verificationBadge: false },
              providerEntitlement: { verificationBadge: false },
              providerStats: {
                jobsCompleted30d: 10,
                cancellationRate30d: 0,
                disputeRate30d: 0,
                reportRate30d: 0,
                medianResponseTimeSeconds30d: 60,
              },
              subscription: { tier: "FREE" },
              pushTokens: [{ token: "ExponentPushToken[ok]", platform: "ios" }],
            },
          ],
        },
        jobMatchNotification: {
          findMany: async () => [],
          groupBy: async () => [],
        },
        notificationPreference: {
          findMany: async () => [
            {
              userId: 200,
              jobMatchEnabled: true,
              jobMatchDigestEnabled: true,
              jobMatchDigestIntervalMinutes: 15,
              jobMatchDigestLastSentAt: null,
              bidEnabled: true,
              messageEnabled: true,
              quietHoursStart: null,
              quietHoursEnd: null,
              timezone: "UTC",
            },
          ],
        },
        notification: {
          groupBy: async () => [],
        },
        backgroundJob: {
          findFirst: async () => null,
          create: async (args: any) => {
            calls.digestJobCreates.push(args);
            return { id: 1 };
          },
          update: async () => {
            throw new Error("backgroundJob.update should not be called in create path");
          },
        },
        $transaction: async (fn: any) => {
          const tx = {
            notification: {
              create: async (args: any) => {
                calls.txNotifCreates.push(args);
                return { id: 1 };
              },
            },
            jobMatchNotification: {
              create: async (args: any) => {
                calls.txJobMatchCreates.push(args);
                return { id: 1 };
              },
            },
          };
          return fn(tx);
        },
      };

      const sendExpoPush = async (...args: any[]) => {
        calls.push.push(args);
      };

      await processJobMatchNotifyWithDeps({
        prisma: prisma as any,
        sendExpoPush: sendExpoPush as any,
        payload: { jobId: 123 },
        now,
      });

      // Digest providers should not receive immediate push nor immediate DB notification.
      assert.equal(calls.push.length, 0);
      assert.equal(calls.txNotifCreates.length, 0);

      // But they should have a match-row created and a digest job scheduled.
      assert.equal(calls.txJobMatchCreates.length, 1);
      assert.equal(calls.digestJobCreates.length, 1);
      assert.equal(calls.digestJobCreates[0].data.type, "JOB_MATCH_DIGEST");
      assert.deepEqual(calls.digestJobCreates[0].data.payload, { providerId: 200 });

      // runAt should be ~ now + interval (15m)
      const runAt = new Date(calls.digestJobCreates[0].data.runAt);
      assert.equal(runAt.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString());
    }
  );
});

test("processJobMatchNotify rolling cap filters digest accumulation", async () => {
  await withEnv(
    {
      MATCH_NOTIFY_PROVIDER_WINDOW_MINUTES: "60",
      MATCH_NOTIFY_PROVIDER_WINDOW_MAX: "1",
    },
    async () => {
      const now = new Date("2026-02-07T12:00:00.000Z");

      const calls: any = {
        txCalled: 0,
        digestJobCreates: 0,
      };

      const prisma: any = {
        job: {
          findUnique: async () => ({
            id: 123,
            title: "Fix sink",
            location: "New York, NY",
            category: null,
            budgetMin: 100,
            budgetMax: 200,
            consumerId: 999,
            isHidden: false,
            createdAt: now,
          }),
        },
        user: {
          findMany: async () => [
            {
              id: 200,
              location: "New York, NY",
              providerProfile: { rating: 5, reviewCount: 10, featuredZipCodes: [], verificationBadge: false },
              providerEntitlement: { verificationBadge: false },
              providerStats: null,
              subscription: { tier: "FREE" },
              pushTokens: [{ token: "ExponentPushToken[ok]", platform: "ios" }],
            },
          ],
        },
        jobMatchNotification: {
          findMany: async () => [],
          groupBy: async () => [{ providerId: 200, _count: { _all: 1 } }],
        },
        notificationPreference: {
          findMany: async () => [
            {
              userId: 200,
              jobMatchEnabled: true,
              jobMatchDigestEnabled: true,
              jobMatchDigestIntervalMinutes: 15,
              jobMatchDigestLastSentAt: null,
              bidEnabled: true,
              messageEnabled: true,
              quietHoursStart: null,
              quietHoursEnd: null,
              timezone: "UTC",
            },
          ],
        },
        notification: {
          groupBy: async () => [],
        },
        backgroundJob: {
          findFirst: async () => null,
          create: async () => {
            calls.digestJobCreates += 1;
            return { id: 1 };
          },
          update: async () => ({ id: 1 }),
        },
        $transaction: async () => {
          calls.txCalled += 1;
          throw new Error("transaction should not run if digest provider is capped");
        },
      };

      const sendExpoPush = async () => {
        throw new Error("sendExpoPush should not be called");
      };

      await processJobMatchNotifyWithDeps({
        prisma: prisma as any,
        sendExpoPush: sendExpoPush as any,
        payload: { jobId: 123 },
        now,
      });

      assert.equal(calls.txCalled, 0);
      assert.equal(calls.digestJobCreates, 0);
    }
  );
});
