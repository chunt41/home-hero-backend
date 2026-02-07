import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createPostJobAwardHandler } from "./jobAward";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function makePrismaStub(seed: {
  job: any | null;
  bidById?: Record<number, any>;
  bidByJobProvider?: Record<string, any>;
  otherBids?: any[];
}) {
  const state = {
    job: seed.job,
    bidById: seed.bidById ?? {},
    bidByJobProvider: seed.bidByJobProvider ?? {},
    bidUpdates: [] as any[],
    bidUpdateManyCalls: [] as any[],
    jobUpdates: [] as any[],
  };

  const prisma = {
    job: {
      findUnique: async (_args: any) => state.job,
    },
    bid: {
      findUnique: async (args: any) => state.bidById[args.where.id] ?? null,
      findFirst: async (args: any) => {
        const key = `${args.where.jobId}:${args.where.providerId}`;
        return state.bidByJobProvider[key] ?? null;
      },
    },
    $transaction: async (fn: any) => {
      const tx = {
        bid: {
          update: async (args: any) => {
            const existing = state.bidById[args.where.id];
            const updated = { ...existing, ...args.data };
            state.bidById[args.where.id] = updated;
            state.bidUpdates.push(args);
            return updated;
          },
          updateMany: async (args: any) => {
            state.bidUpdateManyCalls.push(args);
            return { count: 0 };
          },
        },
        job: {
          update: async (args: any) => {
            const updated = { ...(state.job ?? {}), ...args.data };
            state.job = updated;
            state.jobUpdates.push(args);
            return updated;
          },
        },
      };
      return fn(tx);
    },
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:jobId/award requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });
  const app = express();
  app.use(express.json());
  app.post(
    "/jobs/:jobId/award",
    createPostJobAwardHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/award`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bidId: 1 }),
  });

  assert.equal(res.status, 401);
});

test("POST /jobs/:jobId/award awards by bidId", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 10,
      title: "Fix sink",
      status: "OPEN",
      consumerId: 100,
      awardedProviderId: null,
      awardedAt: null,
    },
    bidById: {
      55: { id: 55, jobId: 10, providerId: 200, status: "PENDING", amount: 123 },
    },
  });

  let notified: any[] = [];
  let webhooks: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 100, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/award",
    createPostJobAwardHandler({
      prisma: prisma as any,
      createNotification: async (n) => {
        notified.push(n);
      },
      enqueueWebhookEvent: async (w) => {
        webhooks.push(w);
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/10/award`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bidId: 55 }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.status, "AWARDED");
  assert.equal(body.job.awardedProviderId, 200);
  assert.ok(body.job.awardedAt);
  assert.equal(body.acceptedBid.status, "ACCEPTED");

  assert.equal(notified.length, 2);
  assert.deepEqual(
    new Set(notified.map((n) => n.userId)),
    new Set([100, 200])
  );
  assert.ok(notified.every((n) => n.type === "JOB_AWARDED"));

  assert.equal(webhooks.length, 2);
  assert.equal(webhooks[0].eventType, "bid.accepted");
  assert.equal(webhooks[1].eventType, "job.status_changed");
});

test("POST /jobs/:jobId/award awards by providerId", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 11,
      title: "Paint fence",
      status: "OPEN",
      consumerId: 101,
      awardedProviderId: null,
      awardedAt: null,
    },
    bidById: {
      77: { id: 77, jobId: 11, providerId: 201, status: "PENDING", amount: 999 },
    },
    bidByJobProvider: {
      "11:201": { id: 77, jobId: 11, providerId: 201, status: "PENDING", amount: 999 },
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 101, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/award",
    createPostJobAwardHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/11/award`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: 201 }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.awardedProviderId, 201);
});
