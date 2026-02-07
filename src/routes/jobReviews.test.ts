import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createPostJobReviewsHandler } from "./jobReviews";

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
  acceptedBid?: any | null;
  existingReview?: any | null;
  createThrowsUnique?: boolean;
}) {
  const state = {
    job: seed.job,
    acceptedBid: seed.acceptedBid ?? null,
    existingReview: seed.existingReview ?? null,
    created: [] as any[],
    updated: [] as any[],
  };

  const prisma = {
    job: {
      findUnique: async (_args: any) => state.job,
    },
    bid: {
      findFirst: async (_args: any) => state.acceptedBid,
    },
    review: {
      findUnique: async (_args: any) => state.existingReview,
      create: async (args: any) => {
        if (seed.createThrowsUnique) {
          throw new Error("Unique constraint failed on the fields: (`jobId`,`reviewerUserId`)");
        }
        const now = new Date("2026-01-01T00:00:00.000Z");
        const review = {
          id: 999,
          ...args.data,
          createdAt: now,
          updatedAt: now,
        };
        state.created.push(args);
        state.existingReview = review;
        return review;
      },
      update: async (args: any) => {
        const now = new Date("2026-01-02T00:00:00.000Z");
        const review = {
          ...(state.existingReview ?? {}),
          ...args.data,
          updatedAt: now,
        };
        state.updated.push(args);
        state.existingReview = review;
        return review;
      },
    },
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:jobId/reviews requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });

  const app = express();
  app.use(express.json());
  app.post(
    "/jobs/:jobId/reviews",
    createPostJobReviewsHandler({
      prisma: prisma as any,
      moderateReviewText: () => ({ ok: true, text: null }),
      recomputeProviderRating: async () => ({ avg: 5, count: 1 }),
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, text: "Great" }),
  });

  assert.equal(res.status, 401);
});

test("POST /jobs/:jobId/reviews blocks reviews until COMPLETED", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 10,
      title: "Fix sink",
      status: "IN_PROGRESS",
      consumerId: 100,
      awardedProviderId: 200,
    },
    acceptedBid: { id: 55, providerId: 200 },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 100, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/reviews",
    createPostJobReviewsHandler({
      prisma: prisma as any,
      moderateReviewText: () => ({ ok: true, text: "ok" }),
      recomputeProviderRating: async () => ({ avg: 5, count: 1 }),
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/10/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, text: "Great" }),
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(String(body.error).includes("Only COMPLETED jobs"));
});

test("POST /jobs/:jobId/reviews creates a consumer->provider review for COMPLETED jobs", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 11,
      title: "Paint fence",
      status: "COMPLETED",
      consumerId: 101,
      awardedProviderId: 201,
    },
    acceptedBid: { id: 77, providerId: 201 },
    existingReview: null,
  });

  const webhooks: any[] = [];
  const recomputeCalls: number[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 101, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/reviews",
    createPostJobReviewsHandler({
      prisma: prisma as any,
      moderateReviewText: (txt) => ({ ok: true, text: txt }),
      recomputeProviderRating: async (providerId) => {
        recomputeCalls.push(providerId);
        return { avg: 4.5, count: 10 };
      },
      enqueueWebhookEvent: async (w) => {
        webhooks.push(w);
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/11/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, text: "Great work" }),
  });

  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(body.review.jobId, 11);
  assert.equal(body.review.reviewerUserId, 101);
  assert.equal(body.review.revieweeUserId, 201);
  assert.equal(body.review.rating, 5);

  assert.deepEqual(recomputeCalls, [201]);

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].eventType, "review.created");
  assert.equal(webhooks[0].payload.acceptedBidId, 77);
});

test("POST /jobs/:jobId/reviews updates an existing review (one per reviewer per job)", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 12,
      title: "Mow lawn",
      status: "COMPLETED",
      consumerId: 102,
      awardedProviderId: 202,
    },
    acceptedBid: { id: 88, providerId: 202 },
    existingReview: {
      id: 500,
      jobId: 12,
      reviewerUserId: 102,
      revieweeUserId: 202,
      rating: 3,
      text: "ok",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const webhooks: any[] = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 102, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:jobId/reviews",
    createPostJobReviewsHandler({
      prisma: prisma as any,
      moderateReviewText: (txt) => ({ ok: true, text: txt }),
      recomputeProviderRating: async () => ({ avg: 4.2, count: 8 }),
      enqueueWebhookEvent: async (w) => {
        webhooks.push(w);
      },
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/12/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 4, text: "Better than ok" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.review.id, 500);
  assert.equal(body.review.rating, 4);
  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].eventType, "review.updated");
});

test("POST /jobs/:jobId/reviews rejects provider if they are not the accepted/awarded provider", async (t) => {
  const prisma = makePrismaStub({
    job: {
      id: 13,
      title: "Assemble furniture",
      status: "COMPLETED",
      consumerId: 103,
      awardedProviderId: 203,
    },
    acceptedBid: { id: 99, providerId: 203 },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:jobId/reviews",
    createPostJobReviewsHandler({
      prisma: prisma as any,
      moderateReviewText: () => ({ ok: true, text: null }),
      recomputeProviderRating: async () => null,
      enqueueWebhookEvent: async () => {},
    })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/13/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, text: "test" }),
  });

  assert.equal(res.status, 403);
});
