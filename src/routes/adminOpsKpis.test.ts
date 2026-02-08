import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetAdminOpsKpisHandler } from "./adminOpsKpis";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("GET /admin/ops/kpis requires auth", async (t) => {
  const prisma = {
    job: { count: async () => 0, findMany: async () => [] },
    message: { count: async () => 0 },
    report: { count: async () => 0, groupBy: async () => [] },
    subscription: { groupBy: async () => [] },
    stripePayment: { groupBy: async () => [] },
  };

  const app = express();
  app.get("/admin/ops/kpis", createGetAdminOpsKpisHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/kpis?windowDays=7`);
  assert.equal(res.status, 401);
});

test("GET /admin/ops/kpis requires admin", async (t) => {
  const prisma = {
    job: { count: async () => 0, findMany: async () => [] },
    message: { count: async () => 0 },
    report: { count: async () => 0, groupBy: async () => [] },
    subscription: { groupBy: async () => [] },
    stripePayment: { groupBy: async () => [] },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/admin/ops/kpis", createGetAdminOpsKpisHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/kpis?windowDays=7`);
  assert.equal(res.status, 403);
});

test("GET /admin/ops/kpis returns expected calculations", async (t) => {
  const now = new Date("2026-02-01T00:00:00.000Z");

  const prisma = {
    job: {
      count: async ({ where }: any) => {
        // jobsPosted: 10; jobsAwarded: 3
        const isAwarded = where?.awardedAt?.not === null;
        return isAwarded ? 3 : 10;
      },
      findMany: async () => {
        // 3 jobs sampled, 2 have bids.
        return [
          { id: 1, createdAt: new Date("2026-01-30T00:00:00.000Z"), bids: [{ createdAt: new Date("2026-01-30T00:10:00.000Z") }] },
          { id: 2, createdAt: new Date("2026-01-30T00:00:00.000Z"), bids: [{ createdAt: new Date("2026-01-30T01:10:00.000Z") }] },
          { id: 3, createdAt: new Date("2026-01-30T00:00:00.000Z"), bids: [] },
        ];
      },
    },
    message: { count: async () => 200 },
    report: {
      count: async () => 5,
      groupBy: async () => [
        { targetType: "USER", _count: { _all: 2 } },
        { targetType: "JOB", _count: { _all: 3 } },
      ],
    },
    subscription: {
      groupBy: async ({ where }: any) => {
        // activePaid: PRO=4; churnedWithinWindow: PRO=1; expiringSoon: PRO=2
        const hasLt = where?.renewsAt?.lt instanceof Date;
        const hasGte = where?.renewsAt?.gte instanceof Date;
        if (hasLt && hasGte) {
          const gteTs = where.renewsAt.gte.getTime();
          if (gteTs === now.getTime()) return [{ tier: "PRO", _count: { _all: 2 } }];
          return [{ tier: "PRO", _count: { _all: 1 } }];
        }
        if (hasLt) return [{ tier: "PRO", _count: { _all: 2 } }];
        if (hasGte) return [{ tier: "PRO", _count: { _all: 4 } }];
        return [];
      },
    },
    stripePayment: {
      groupBy: async () => [{ tier: "PRO", _count: { _all: 7 } }],
    },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "ADMIN" };
    next();
  });
  app.get("/admin/ops/kpis", createGetAdminOpsKpisHandler({ prisma, now: () => now }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/kpis?windowDays=30&maxJobsForBidLatency=3`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.postToAwardConversion.jobsPosted, 10);
  assert.equal(body.postToAwardConversion.jobsAwarded, 3);
  assert.equal(body.postToAwardConversion.conversion, 0.3);

  assert.equal(body.timeToFirstBid.sampledJobs, 3);
  assert.equal(body.timeToFirstBid.jobsWithAtLeastOneBid, 2);
  assert.equal(body.timeToFirstBid.avgMinutes, 40);
  assert.equal(body.timeToFirstBid.p50Minutes, 40);

  assert.equal(body.reportRate.reportsCreated, 5);
  assert.equal(body.reportRate.jobsPosted, 10);
  assert.equal(body.reportRate.messagesCreated, 200);
  assert.equal(body.reportRate.per100JobsPosted, 50);
  assert.equal(body.reportRate.per1000MessagesCreated, 25);

  assert.deepEqual(body.churnByTier.activePaidByTier, { PRO: 4 });
  assert.deepEqual(body.churnByTier.churnedByTier, { PRO: 1 });
  assert.deepEqual(body.churnByTier.expiringSoonByTier, { PRO: 2 });
  assert.deepEqual(body.churnByTier.successfulSubscriptionPaymentsByTier, { PRO: 7 });
  assert.equal(body.churnByTier.churnRateByTier.PRO, 0.2);
});
