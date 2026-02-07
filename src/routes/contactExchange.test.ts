import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import {
  createGetContactExchangeHandler,
  createPostContactExchangeDecideHandler,
  createPostContactExchangeRequestHandler,
} from "./contactExchange";

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
  users?: Record<number, any>;
  requests?: any[];
}) {
  const state = {
    job: seed.job,
    users: seed.users ?? {},
    requests: (seed.requests ?? []).map((r, i) => ({
      id: r.id ?? i + 1,
      createdAt: r.createdAt ?? new Date(),
      decidedAt: r.decidedAt ?? null,
      status: r.status ?? "PENDING",
      ...r,
    })),
    nextId: 100,
  };

  function matchWhere(req: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === "requestedByUserId" && v && typeof v === "object" && "not" in v) {
        if (req.requestedByUserId === (v as any).not) return false;
        continue;
      }
      if ((req as any)[k] !== v) return false;
    }
    return true;
  }

  const prisma = {
    job: {
      findUnique: async (args: any) => {
        if (!state.job) return null;
        if (args?.where?.id !== state.job.id) return null;
        return state.job;
      },
    },
    contactExchangeRequest: {
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        const filtered = state.requests
          .filter((r) => matchWhere(r, where))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const first = filtered[0] ?? null;
        if (!first) return null;
        return first;
      },
      create: async (args: any) => {
        const created = {
          id: state.nextId++,
          createdAt: new Date(),
          decidedAt: null,
          ...args.data,
        };
        state.requests.push(created);
        return created;
      },
      update: async (args: any) => {
        const idx = state.requests.findIndex((r) => r.id === args.where.id);
        if (idx < 0) throw new Error("Not found");
        state.requests[idx] = { ...state.requests[idx], ...args.data };
        return state.requests[idx];
      },
    },
    user: {
      findUnique: async (args: any) => {
        const id = args?.where?.id;
        return state.users[id] ?? null;
      },
    },
    __state: state,
  };

  return prisma;
}

test("POST /jobs/:id/contact-exchange/request requires auth", async (t) => {
  const prisma = makePrismaStub({ job: null });
  const app = express();
  app.use(express.json());

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 401);
});

test("POST /jobs/:id/contact-exchange/request requires awarded provider", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: null, status: "OPEN" },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "CONTACT_EXCHANGE_NOT_AVAILABLE");
});

test("POST /jobs/:id/contact-exchange/request forbids non-participants", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 403);
});

test("POST /jobs/:id/contact-exchange/request creates pending request", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any, cooldownMs: 10 * 60_000 })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.jobId, 1);
  assert.equal(body.request.requestedByUserId, 10);
  assert.equal(body.request.status, "PENDING");

  assert.equal((prisma as any).__state.requests.length, 1);
});

test("POST /jobs/:id/contact-exchange/request returns 409 if pending exists", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
    requests: [{ jobId: 1, requestedByUserId: 10, status: "PENDING", createdAt: new Date() }],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 20, role: "PROVIDER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "CONTACT_EXCHANGE_ALREADY_PENDING");
});

test("POST /jobs/:id/contact-exchange/request enforces cooldown", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
    requests: [
      {
        jobId: 1,
        requestedByUserId: 10,
        status: "REJECTED",
        createdAt: new Date(Date.now() - 5_000),
      },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/request",
    createPostContactExchangeRequestHandler({ prisma: prisma as any, cooldownMs: 60_000 })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, "CONTACT_EXCHANGE_COOLDOWN");
  assert.ok(body.retryAfterSeconds > 0);
});

test("POST /jobs/:id/contact-exchange/decide approves by the other participant", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
    requests: [{ id: 5, jobId: 1, requestedByUserId: 10, status: "PENDING", createdAt: new Date() }],
  });

  const app = express();
  app.use(express.json());

  // actor is the requester: should not be able to decide
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.post(
    "/jobs/:id/contact-exchange/decide",
    createPostContactExchangeDecideHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res1 = await fetch(`${baseUrl}/jobs/1/contact-exchange/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "APPROVE" }),
  });

  assert.equal(res1.status, 404);
  const body1 = await res1.json();
  assert.equal(body1.code, "CONTACT_EXCHANGE_NOT_PENDING");

  // now decide as the other participant
  const app2 = express();
  app2.use(express.json());
  app2.use((req, _res, next) => {
    (req as any).user = { userId: 20, role: "PROVIDER" };
    next();
  });
  app2.post(
    "/jobs/:id/contact-exchange/decide",
    createPostContactExchangeDecideHandler({ prisma: prisma as any })
  );

  const { server: server2, baseUrl: baseUrl2 } = await listen(app2);
  t.after(() => server2.close());

  const res2 = await fetch(`${baseUrl2}/jobs/1/contact-exchange/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "APPROVE" }),
  });

  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.request.status, "APPROVED");
  assert.ok(body2.request.decidedAt);
});

test("GET /jobs/:id/contact-exchange returns approved=false when not approved", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
    requests: [{ id: 5, jobId: 1, requestedByUserId: 10, status: "PENDING", createdAt: new Date() }],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 20, role: "PROVIDER" };
    next();
  });

  app.get(
    "/jobs/:id/contact-exchange",
    createGetContactExchangeHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approved, false);
  assert.equal(body.jobId, 1);
  assert.equal(body.request.status, "PENDING");
});

test("GET /jobs/:id/contact-exchange returns contact when approved", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
    users: {
      10: { id: 10, name: "Alice", email: "a@example.com", phone: "111" },
      20: { id: 20, name: "Bob", email: "b@example.com", phone: "222" },
    },
    requests: [
      {
        id: 5,
        jobId: 1,
        requestedByUserId: 10,
        status: "APPROVED",
        createdAt: new Date(Date.now() - 10_000),
        decidedAt: new Date(),
      },
    ],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 10, role: "CONSUMER" };
    next();
  });

  app.get(
    "/jobs/:id/contact-exchange",
    createGetContactExchangeHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.approved, true);
  assert.equal(body.contact.consumer.email, "a@example.com");
  assert.equal(body.contact.provider.email, "b@example.com");
});

test("GET /jobs/:id/contact-exchange forbids non-participants", async (t) => {
  const prisma = makePrismaStub({
    job: { id: 1, consumerId: 10, awardedProviderId: 20, status: "AWARDED" },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "CONSUMER" };
    next();
  });

  app.get(
    "/jobs/:id/contact-exchange",
    createGetContactExchangeHandler({ prisma: prisma as any })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/1/contact-exchange`);
  assert.equal(res.status, 403);
});
