import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import {
  createPostAdminResolveDisputeHandler,
  createPostJobDisputesHandler,
} from "./jobDisputes";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("POST /jobs/:jobId/disputes blocks unless status is IN_PROGRESS/COMPLETED_PENDING_CONFIRMATION/COMPLETED", async (t) => {
  const prisma: any = {
    job: {
      findUnique: async () => ({
        id: 1,
        consumerId: 10,
        status: "OPEN",
        title: "Job",
        awardedProviderId: 20,
      }),
      update: async () => {
        throw new Error("job.update should not be called");
      },
    },
    bid: {
      findFirst: async () => ({ providerId: 20 }),
    },
    dispute: {
      findFirst: async () => null,
      create: async () => {
        throw new Error("dispute.create should not be called");
      },
    },
    user: {
      findMany: async () => [{ id: 999 }],
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/disputes",
    createPostJobDisputesHandler({
      prisma,
      createNotification: async () => {},
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/disputes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "OTHER", description: "x" }),
  });

  assert.equal(res.status, 400);
});

test("POST /jobs/:jobId/disputes opens dispute, sets job DISPUTED, and notifies admins", async (t) => {
  const notifications: any[] = [];
  const audits: any[] = [];

  const state: any = {
    job: {
      id: 2,
      consumerId: 10,
      status: "IN_PROGRESS",
      title: "Fix sink",
      awardedProviderId: 20,
    },
  };

  const prisma: any = {
    job: {
      findUnique: async () => state.job,
      update: async ({ data }: any) => {
        state.job = { ...state.job, ...data };
        return { id: state.job.id, status: state.job.status };
      },
    },
    bid: {
      findFirst: async () => ({ providerId: 20 }),
    },
    dispute: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({
        id: 500,
        ...data,
        status: "OPEN",
        createdAt: new Date("2026-02-06T00:00:00.000Z"),
      }),
    },
    user: {
      findMany: async () => [{ id: 9001 }, { id: 9002 }],
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/disputes",
    createPostJobDisputesHandler({
      prisma,
      createNotification: async (n) => {
        notifications.push(n);
      },
      enqueueWebhookEvent: async () => {},
      auditSecurityEvent: async (_req, actionType, metadata) => {
        audits.push({ actionType, metadata });
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/2/disputes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasonCode: "QUALITY", description: "Not good" }),
  });

  assert.equal(res.status, 201);
  assert.equal(state.job.status, "DISPUTED");

  const adminNotifs = notifications.filter((n) => n.type === "ADMIN_JOB_DISPUTED");
  assert.equal(adminNotifs.length, 2);
  assert.deepEqual(new Set(adminNotifs.map((n) => n.userId)), new Set([9001, 9002]));

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actionType, "job.disputed");
});

test("POST /admin/disputes/:id/resolve resolves dispute, sets job status, and audits", async (t) => {
  const notifications: any[] = [];
  const audits: any[] = [];

  const state: any = {
    dispute: {
      id: 700,
      jobId: 3,
      status: "OPEN",
      reasonCode: "OTHER",
      openedByUserId: 10,
    },
    job: {
      id: 3,
      title: "Paint fence",
      status: "DISPUTED",
      consumerId: 10,
      awardedProviderId: 20,
    },
  };

  const prisma: any = {
    dispute: {
      findUnique: async () => state.dispute,
      update: async ({ data }: any) => {
        state.dispute = { ...state.dispute, ...data };
        return state.dispute;
      },
    },
    job: {
      findUnique: async () => state.job,
      update: async ({ data }: any) => {
        state.job = { ...state.job, ...data };
        return { id: state.job.id, status: state.job.status };
      },
    },
    bid: {
      findFirst: async () => ({ providerId: 20 }),
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "ADMIN" };
    next();
  });

  app.post(
    "/admin/disputes/:id/resolve",
    createPostAdminResolveDisputeHandler({
      prisma,
      createNotification: async (n) => {
        notifications.push(n);
      },
      enqueueWebhookEvent: async () => {},
      auditSecurityEvent: async (_req, actionType, metadata) => {
        audits.push({ actionType, metadata });
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/disputes/700/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobStatus: "COMPLETED", resolutionNotes: "Refunded" }),
  });

  assert.equal(res.status, 200);
  assert.equal(state.dispute.status, "RESOLVED");
  assert.equal(state.dispute.resolutionJobStatus, "COMPLETED");
  assert.equal(state.dispute.resolvedByAdminId, 999);
  assert.equal(state.job.status, "COMPLETED");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actionType, "dispute.resolved");

  const participantNotifs = notifications.filter((n) => n.type === "DISPUTE_RESOLVED");
  assert.equal(participantNotifs.length, 2);
});
