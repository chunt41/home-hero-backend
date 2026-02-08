import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetAdminMessageViolationsHandler } from "./adminMessageViolations";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("GET /admin/messages/violations requires admin", async (t) => {
  const prisma = {
    securityEvent: { groupBy: async () => [] },
    user: { findMany: async () => [] },
  };

  const app = express();
  app.get("/admin/messages/violations", createGetAdminMessageViolationsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/messages/violations`);
  assert.equal(res.status, 401);
});

test("GET /admin/messages/violations lists repeated violators", async (t) => {
  const now = new Date();

  const prisma = {
    securityEvent: {
      groupBy: async () => [
        { actorUserId: 10, _count: { _all: 3 }, _max: { createdAt: now } },
        { actorUserId: 20, _count: { _all: 2 }, _max: { createdAt: now } },
      ],
    },
    user: {
      findMany: async (args: any) => {
        const ids = args?.where?.id?.in ?? [];
        return ids.includes(10)
          ? [
              {
                id: 10,
                email: "u10@example.com",
                name: "User 10",
                role: "CONSUMER",
                riskScore: 123,
                restrictedUntil: null,
                isSuspended: false,
                createdAt: new Date("2025-01-01T00:00:00Z"),
              },
            ]
          : [];
      },
    },
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "ADMIN" };
    next();
  });

  app.get("/admin/messages/violations", createGetAdminMessageViolationsHandler({ prisma }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/messages/violations?windowMinutes=10&minBlocks=3&limit=50`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.windowMinutes, 10);
  assert.equal(body.minBlocks, 3);
  assert.equal(body.users.length, 1);
  assert.equal(body.users[0].userId, 10);
  assert.equal(body.users[0].blockCount, 3);
  assert.equal(body.users[0].user.email, "u10@example.com");
});
