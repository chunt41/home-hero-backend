import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createPostJobStartHandler } from "./jobStart";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function makePrismaStub(seed: { job: any | null }) {
  const state = {
    job: seed.job,
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
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:id/start requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });
  const app = express();
  app.use(express.json());
  app.post(
    "/jobs/:id/start",
    createPostJobStartHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/start`, { method: "POST" });
  assert.equal(res.status, 401);
});

test("POST /jobs/:id/start rejects non-provider", async (t) => {
  const prisma = makePrismaStub({ job: null });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 123, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/start",
    createPostJobStartHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/start`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("POST /jobs/:id/start rejects when job not AWARDED", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 10,
      title: "Fix sink",
      status: "OPEN",
      consumerId: 100,
      awardedProviderId: 200,
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 200, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:id/start",
    createPostJobStartHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/10/start`, { method: "POST" });
  assert.equal(res.status, 400);
});

test("POST /jobs/:id/start rejects when provider is not awarded provider", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 11,
      title: "Paint fence",
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
    "/jobs/:id/start",
    createPostJobStartHandler({
      prisma: prisma as any,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/11/start`, { method: "POST" });
  assert.equal(res.status, 403);
});

test("POST /jobs/:id/start transitions AWARDED -> IN_PROGRESS, notifies, and emits webhook", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 12,
      title: "Mow lawn",
      status: "AWARDED",
      consumerId: 102,
      awardedProviderId: 202,
    },
  });

  const notified: any[] = [];
  const webhooks: any[] = [];
  const audits: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 202, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:id/start",
    createPostJobStartHandler({
      prisma: prisma as any,
      createNotification: async (n) => {
        notified.push(n);
      },
      enqueueWebhookEvent: async (w) => {
        webhooks.push(w);
      },
      auditSecurityEvent: async (_req, actionType, metadata) => {
        audits.push({ actionType, metadata });
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/12/start`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.job.status, "IN_PROGRESS");
  assert.equal(prisma.__state.jobUpdates.length, 1);

  assert.equal(notified.length, 2);
  assert.deepEqual(
    new Set(notified.map((n) => n.userId)),
    new Set([102, 202])
  );
  assert.ok(notified.every((n) => n.type === "JOB_STARTED"));

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].eventType, "job.status_changed");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actionType, "job.started");
});
