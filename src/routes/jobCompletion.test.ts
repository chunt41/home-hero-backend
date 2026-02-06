import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import {
  createPostJobConfirmCompleteHandler,
  createPostJobMarkCompleteHandler,
} from "./jobCompletion";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function makePrismaStub(seed: { job: any | null; acceptedBidProviderId?: number | null }) {
  const state = {
    job: seed.job,
    acceptedBidProviderId: seed.acceptedBidProviderId ?? null,
    jobUpdates: [] as any[],
  };

  const prisma = {
    job: {
      findUnique: async (_args: any) => state.job,
      update: async (args: any) => {
        const updated = { ...(state.job ?? {}), ...args.data };
        state.job = updated;
        state.jobUpdates.push(args);
        return updated;
      },
    },
    bid: {
      findFirst: async (_args: any) => {
        if (!state.acceptedBidProviderId) return null;
        return { providerId: state.acceptedBidProviderId };
      },
    },
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:id/mark-complete requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });

  const app = express();
  app.use(express.json());
  app.post(
    "/jobs/:id/mark-complete",
    createPostJobMarkCompleteHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/mark-complete`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("POST /jobs/:id/mark-complete by consumer sets pending for provider", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 10,
      title: "Fix sink",
      location: "Kitchen",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "IN_PROGRESS",
      consumerId: 100,
      awardedProviderId: 200,
      completionPendingForUserId: null,
      completedAt: null,
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
    "/jobs/:id/mark-complete",
    createPostJobMarkCompleteHandler({
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

  const res = await fetch(`${baseUrl}/jobs/10/mark-complete`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.job.status, "COMPLETED_PENDING_CONFIRMATION");
  assert.equal(body.job.completionPendingForUserId, 200);

  assert.equal(notified.length, 2);
  assert.equal(notified[0].userId, 200);
  assert.equal(notified[0].type, "JOB_COMPLETION_CONFIRM_REQUIRED");
  assert.equal(notified[1].userId, 100);
  assert.equal(notified[1].type, "JOB_COMPLETION_MARKED");

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].eventType, "job.status_changed");
});

test("POST /jobs/:id/mark-complete by provider sets pending for consumer", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 11,
      title: "Paint fence",
      location: "Backyard",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "IN_PROGRESS",
      consumerId: 101,
      awardedProviderId: 201,
      completionPendingForUserId: null,
      completedAt: null,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 201, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:id/mark-complete",
    createPostJobMarkCompleteHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/11/mark-complete`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.job.status, "COMPLETED_PENDING_CONFIRMATION");
  assert.equal(body.job.completionPendingForUserId, 101);
});

test("POST /jobs/:id/confirm-complete only pending user can confirm", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 12,
      title: "Mow lawn",
      location: "Front",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "COMPLETED_PENDING_CONFIRMATION",
      consumerId: 102,
      awardedProviderId: 202,
      completionPendingForUserId: 202,
      completedAt: null,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 102, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/confirm-complete",
    createPostJobConfirmCompleteHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/12/confirm-complete`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("POST /jobs/:id/confirm-complete completes job and emits webhooks", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 13,
      title: "Assemble furniture",
      location: "Living room",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "COMPLETED_PENDING_CONFIRMATION",
      consumerId: 103,
      awardedProviderId: 203,
      completionPendingForUserId: 203,
      completedAt: null,
    },
  });

  const notified: any[] = [];
  const webhooks: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 203, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:id/confirm-complete",
    createPostJobConfirmCompleteHandler({
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

  const res = await fetch(`${baseUrl}/jobs/13/confirm-complete`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.job.status, "COMPLETED");
  assert.equal(body.job.completionPendingForUserId, null);
  assert.ok(body.job.completedAt);

  // Both parties get JOB_COMPLETED
  assert.equal(notified.length, 2);
  assert.deepEqual(
    new Set(notified.map((n) => n.userId)),
    new Set([103, 203])
  );
  assert.ok(notified.every((n) => n.type === "JOB_COMPLETED"));

  // job.completed + job.status_changed
  assert.equal(webhooks.length, 2);
  assert.deepEqual(
    webhooks.map((w) => w.eventType),
    ["job.completed", "job.status_changed"]
  );
});
