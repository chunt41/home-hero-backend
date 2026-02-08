import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createPostJobCancelHandler } from "./jobCancellation";

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
  acceptedBidProviderId?: number | null;
}) {
  const state = {
    job: seed.job,
    acceptedBidProviderId: seed.acceptedBidProviderId ?? null,
    jobUpdates: [] as any[],
    bidUpdateMany: [] as any[],
    txCalls: 0,
  };

  const prisma = {
    job: {
      findUnique: async (_args: any) => state.job,
      update: async (args: any) => {
        const updated = { ...(state.job ?? {}), ...args.data };
        state.job = updated;
        state.jobUpdates.push(args);
        return args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, (updated as any)[k]])) : updated;
      },
    },
    bid: {
      findFirst: async (_args: any) => {
        if (!state.acceptedBidProviderId) return null;
        return { providerId: state.acceptedBidProviderId };
      },
      updateMany: async (args: any) => {
        state.bidUpdateMany.push(args);
        return { count: 1 };
      },
    },
    $transaction: async (ops: any[]) => {
      state.txCalls += 1;
      const results = [] as any[];
      for (const op of ops) {
        results.push(await op);
      }
      return results;
    },
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:jobId/cancel requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });

  const app = express();
  app.use(express.json());
  app.post(
    "/jobs/:jobId/cancel",
    createPostJobCancelHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "CHANGE_OF_PLANS" }),
  });

  assert.equal(res.status, 401);
});

test("POST /jobs/:jobId/cancel by consumer cancels own job and stores reason", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 10,
      title: "Fix sink",
      location: "Kitchen",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "OPEN",
      consumerId: 100,
      awardedProviderId: null,
      cancelledAt: null,
      cancelledByUserId: null,
      cancellationReasonCode: null,
      cancellationReasonDetails: null,
    },
  });

  const notified: any[] = [];
  const webhooks: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 100, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/cancel",
    createPostJobCancelHandler({
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

  const res = await fetch(`${baseUrl}/jobs/10/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "SCHEDULING_CONFLICT", reasonDetails: "Out of town" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.job.status, "CANCELLED");
  assert.equal(body.job.cancellationReasonCode, "SCHEDULING_CONFLICT");

  assert.ok(notified.length >= 1);
  assert.equal(webhooks.length, 2);
  assert.equal(webhooks[0].eventType, "job.cancelled");
  assert.equal(webhooks[1].eventType, "job.status_changed");
});

test("POST /jobs/:jobId/cancel by provider only allowed if awarded provider", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 11,
      title: "Paint fence",
      location: "Backyard",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "AWARDED",
      consumerId: 101,
      awardedProviderId: 201,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:jobId/cancel",
    createPostJobCancelHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/11/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "UNRESPONSIVE" }),
  });

  assert.equal(res.status, 403);
});

test("POST /jobs/:jobId/cancel by awarded provider succeeds for IN_PROGRESS", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 13,
      title: "Install faucet",
      location: "Bathroom",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "IN_PROGRESS",
      consumerId: 103,
      awardedProviderId: 203,
      cancelledAt: null,
      cancelledByUserId: null,
      cancellationReasonCode: null,
      cancellationReasonDetails: null,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 203, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:jobId/cancel",
    createPostJobCancelHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/13/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "UNRESPONSIVE" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.job.status, "CANCELLED");
  assert.equal(body.job.cancellationReasonCode, "UNRESPONSIVE");
  assert.equal(body.job.cancellationReasonLabel, "Unresponsive");
});

test("POST /jobs/:jobId/cancel requires reasonCode", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 12,
      title: "Mow lawn",
      location: "Front",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "OPEN",
      consumerId: 102,
      awardedProviderId: null,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 102, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/cancel",
    createPostJobCancelHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/12/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
});
