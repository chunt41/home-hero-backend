import test from "node:test";
import assert from "node:assert/strict";

import { createRoleRateLimitRedis, type RedisLike } from "./rateLimitRedis";

function createRedisMock(nowMs: () => number): RedisLike {
  const store = new Map<string, { value: number; expiresAtMs: number | null }>();

  function cleanup(key: string) {
    const row = store.get(key);
    if (!row) return;
    if (row.expiresAtMs !== null && row.expiresAtMs <= nowMs()) {
      store.delete(key);
    }
  }

  return {
    incr: async (key) => {
      cleanup(key);
      const row = store.get(key) ?? { value: 0, expiresAtMs: null };
      row.value += 1;
      store.set(key, row);
      return row.value;
    },
    pExpire: async (key, ttlMs) => {
      cleanup(key);
      const row = store.get(key) ?? { value: 0, expiresAtMs: null };
      row.expiresAtMs = nowMs() + ttlMs;
      store.set(key, row);
      return 1;
    },
    pTTL: async (key) => {
      cleanup(key);
      const row = store.get(key);
      if (!row) return -2;
      if (row.expiresAtMs === null) return -1;
      return row.expiresAtMs - nowMs();
    },
  };
}

test("rateLimitRedis: increments and blocks when over limit", async () => {
  let now = 1_000_000;
  const redis = createRedisMock(() => now);

  const mw = createRoleRateLimitRedis({
    bucket: "test_bucket",
    windowMs: 60_000,
    limits: { UNKNOWN: 2 },
    redis,
    redisPrefix: "t",
  });

  const mkReq = () =>
    ({
      ip: "203.0.113.10",
      get: (h: string) => (h.toLowerCase() === "user-agent" ? "ua" : ""),
      headers: {},
    }) as any;

  const mkRes = () => {
    const headers: Record<string, string> = {};
    return {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      statusCode: 200,
      status(s: number) {
        this.statusCode = s;
        return this;
      },
      json(body: any) {
        return { statusCode: this.statusCode, body, headers };
      },
      _headers: headers,
    } as any;
  };

  // 1st request OK
  {
    const req = mkReq();
    const res = mkRes();
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res._headers["X-RateLimit-Limit"], "2");
  }

  // 2nd request OK
  {
    const req = mkReq();
    const res = mkRes();
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res._headers["X-RateLimit-Remaining"], "0");
  }

  // 3rd request blocked
  {
    const req = mkReq();
    const res = mkRes();
    let nextCalled = false;
    const result = await mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.deepEqual(result, {
      statusCode: 429,
      body: { error: "Too many requests. Please slow down." },
      headers: res._headers,
    });
  }

  // After window, OK again
  now += 60_000;
  {
    const req = mkReq();
    const res = mkRes();
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  }
});

test("rateLimitRedis: uses userId key when available", async () => {
  let now = 1_000_000;
  const redis = createRedisMock(() => now);

  const mw = createRoleRateLimitRedis({
    bucket: "b",
    windowMs: 60_000,
    limits: { UNKNOWN: 1, CONSUMER: 1 },
    redis,
    redisPrefix: "t",
  });

  const req = {
    ip: "203.0.113.10",
    get: (_h: string) => "ua",
    user: { userId: 42, role: "CONSUMER" },
  } as any;

  const res = {
    setHeader: (_k: string, _v: string) => {},
    status: (_s: number) => res,
    json: (_b: any) => ({ ok: false }),
  } as any;

  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
