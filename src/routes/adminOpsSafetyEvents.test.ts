import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetAdminOpsSafetyEventsHandler } from "./adminOpsSafetyEvents";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("GET /admin/ops/safety-events requires auth", async (t) => {
  const prisma = { securityEvent: { findMany: async () => [] } };
  const app = express();
  app.get("/admin/ops/safety-events", createGetAdminOpsSafetyEventsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/safety-events`);
  assert.equal(res.status, 401);
});

test("GET /admin/ops/safety-events requires admin", async (t) => {
  const prisma = { securityEvent: { findMany: async () => [] } };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/admin/ops/safety-events", createGetAdminOpsSafetyEventsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/safety-events`);
  assert.equal(res.status, 403);
});

test("GET /admin/ops/safety-events returns items", async (t) => {
  const prisma = {
    securityEvent: {
      findMany: async () => [
        {
          id: 1,
          actionType: "message.shadow_hidden",
          actorUserId: 10,
          actorRole: "CONSUMER",
          actorEmail: null,
          targetType: "MESSAGE",
          targetId: "123",
          ip: "127.0.0.1",
          userAgent: "test",
          metadataJson: { requestId: "req-1", reason: "repeated_message" },
          createdAt: new Date("2026-02-07T00:00:00.000Z"),
        },
      ],
    },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "ADMIN" };
    next();
  });
  app.get("/admin/ops/safety-events", createGetAdminOpsSafetyEventsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/ops/safety-events?take=10&sinceHours=24`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(Array.isArray(body.items));
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].actionType, "message.shadow_hidden");
  assert.equal(body.items[0].metadata.requestId, "req-1");
});
