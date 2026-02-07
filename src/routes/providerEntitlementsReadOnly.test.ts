import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetProviderEntitlementsHandler } from "./providerEntitlements";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("GET /provider/entitlements is read-only (no DB writes)", async (t) => {
  const prisma = {
    providerEntitlement: {
      findUnique: async (_args: any) => null,
      upsert: async () => {
        throw new Error("providerEntitlement.upsert should not be called");
      },
      update: async () => {
        throw new Error("providerEntitlement.update should not be called");
      },
      create: async () => {
        throw new Error("providerEntitlement.create should not be called");
      },
      updateMany: async () => {
        throw new Error("providerEntitlement.updateMany should not be called");
      },
      deleteMany: async () => {
        throw new Error("providerEntitlement.deleteMany should not be called");
      },
    },
  };

  const app = express();
  app.use((_req, _res, next) => next());
  app.use((req, _res, next) => {
    (req as any).user = { userId: 123, role: "PROVIDER" };
    next();
  });

  app.get("/provider/entitlements", createGetProviderEntitlementsHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/provider/entitlements`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.entitlements, {
    providerId: 123,
    verificationBadge: false,
    featuredZipCodes: [],
    leadCredits: 0,
  });
});

test("GET /provider/entitlements returns 403 for non-provider", async (t) => {
  const prisma = {
    providerEntitlement: {
      findUnique: async () => {
        throw new Error("findUnique should not be called for non-provider");
      },
    },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 123, role: "CONSUMER" };
    next();
  });
  app.get("/provider/entitlements", createGetProviderEntitlementsHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/provider/entitlements`);
  assert.equal(res.status, 403);
});
