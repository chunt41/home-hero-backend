import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetAdminAiMetricsHandler } from "./adminAiMetrics";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("GET /admin/ai/metrics requires auth", async (t) => {
  const prisma = { user: {}, securityEvent: {} };
  const app = express();
  app.get("/admin/ai/metrics", createGetAdminAiMetricsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ai/metrics`);
  assert.equal(res.status, 401);
});

test("GET /admin/ai/metrics requires admin", async (t) => {
  const prisma = { user: {}, securityEvent: {} };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/admin/ai/metrics", createGetAdminAiMetricsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ai/metrics`);
  assert.equal(res.status, 403);
});

test("GET /admin/ai/metrics returns metrics", async (t) => {
  const prisma = {
    user: {
      aggregate: async ({ where }: any) => {
        const tier = where?.subscription?.is?.tier ?? "FREE";
        if (tier === "PRO") return { _sum: { aiTokensUsedThisMonth: 5000 }, _count: { _all: 2 } };
        if (tier === "BASIC") return { _sum: { aiTokensUsedThisMonth: 2000 }, _count: { _all: 3 } };
        return { _sum: { aiTokensUsedThisMonth: 0 }, _count: { _all: 0 } };
      },
      findMany: async () => [
        {
          id: 10,
          name: "A",
          email: "a@example.com",
          role: "PROVIDER",
          aiMonthlyTokenLimit: null,
          aiTokensUsedThisMonth: 4000,
          subscription: { tier: "PRO" },
        },
      ],
    },
    securityEvent: {
      count: async ({ where }: any) => {
        if (where?.actionType === "ai.cache_hit") return 8;
        if (where?.actionType === "ai.provider_call") return 2;
        if (where?.actionType === "ai.blocked_quota") return 1;
        return 0;
      },
    },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "ADMIN" };
    next();
  });
  app.get("/admin/ai/metrics", createGetAdminAiMetricsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ai/metrics?monthKey=2026-02&topUsersLimit=10`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.monthKey, "2026-02");
  assert.equal(body.cache.hits, 8);
  assert.equal(body.cache.providerCalls, 2);
  assert.equal(body.cache.hitRatio, 0.8);
  assert.equal(body.blockedCalls, 1);

  assert.equal(body.tokensUsedPerTier.PRO.tokensUsed, 5000);
  assert.equal(body.tokensUsedPerTier.BASIC.tokensUsed, 2000);
  assert.ok(Array.isArray(body.topCostUsers));
  assert.equal(body.topCostUsers.length, 1);
  assert.equal(body.topCostUsers[0].id, 10);
});
