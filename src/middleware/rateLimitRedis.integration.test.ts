import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createRoleRateLimitRedis, type RedisLike } from "./rateLimitRedis";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function createInMemoryRedis(): RedisLike {
  const store = new Map<string, { v: number; expiresAt: number | null }>();

  function cleanup(key: string) {
    const row = store.get(key);
    if (!row) return;
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      store.delete(key);
    }
  }

  return {
    incr: async (key) => {
      cleanup(key);
      const row = store.get(key) ?? { v: 0, expiresAt: null };
      row.v += 1;
      store.set(key, row);
      return row.v;
    },
    pExpire: async (key, ttlMs) => {
      cleanup(key);
      const row = store.get(key) ?? { v: 0, expiresAt: null };
      row.expiresAt = Date.now() + ttlMs;
      store.set(key, row);
      return 1;
    },
    pTTL: async (key) => {
      cleanup(key);
      const row = store.get(key);
      if (!row) return -2;
      if (row.expiresAt === null) return -1;
      return row.expiresAt - Date.now();
    },
  };
}

test("rateLimitRedis integration: second request exceeds small limit", async (t) => {
  const redis = createInMemoryRedis();

  const limiter = createRoleRateLimitRedis({
    bucket: "integration",
    windowMs: 60_000,
    limits: { UNKNOWN: 1 },
    redis,
    redisPrefix: "t",
  });

  const app = express();
  app.get(
    "/limited",
    (req, _res, next) => {
      // Ensure a stable UA
      req.headers["user-agent"] = "ua";
      next();
    },
    limiter,
    (_req, res) => res.json({ ok: true })
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const r1 = await fetch(`${baseUrl}/limited`);
  assert.equal(r1.status, 200);

  const r2 = await fetch(`${baseUrl}/limited`);
  assert.equal(r2.status, 429);
  const body = await r2.json();
  assert.equal(body.error, "Too many requests. Please slow down.");
});
