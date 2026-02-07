import test from "node:test";
import assert from "node:assert/strict";

import { createLoginBruteForceProtector, type RedisKV } from "./loginBruteForceProtector";

function createRedisMock(nowMs: () => number): RedisKV {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  function cleanup(key: string) {
    const row = store.get(key);
    if (!row) return;
    if (row.expiresAt !== null && row.expiresAt <= nowMs()) {
      store.delete(key);
    }
  }

  return {
    get: async (key) => {
      cleanup(key);
      return store.get(key)?.value ?? null;
    },
    set: async (key, value, opts) => {
      cleanup(key);
      store.set(key, {
        value,
        expiresAt: typeof opts?.PX === "number" ? nowMs() + opts.PX : null,
      });
      return "OK";
    },
    del: async (key) => {
      cleanup(key);
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    incr: async (key) => {
      cleanup(key);
      const cur = store.get(key);
      const next = (cur ? Number(cur.value) : 0) + 1;
      store.set(key, { value: String(next), expiresAt: cur?.expiresAt ?? null });
      return next;
    },
    pExpire: async (key, ttlMs) => {
      cleanup(key);
      const cur = store.get(key) ?? { value: "0", expiresAt: null };
      cur.expiresAt = nowMs() + ttlMs;
      store.set(key, cur);
      return 1;
    },
    pTTL: async (key) => {
      cleanup(key);
      const cur = store.get(key);
      if (!cur) return -2;
      if (cur.expiresAt === null) return -1;
      return cur.expiresAt - nowMs();
    },
  };
}

test("login brute force: lockout after N failures and reset on success", async () => {
  let now = 1_000_000;
  const redis = createRedisMock(() => now);

  const protector = createLoginBruteForceProtector({
    redis,
    prefix: "t",
    policy: {
      windowMs: 60_000,
      cooldownMs: 30_000,
      maxFailuresPerIp: 3,
      maxFailuresPerIdentity: 2,
    },
  });

  const req = { ip: "203.0.113.5" } as any;

  // 1st failure ok
  {
    const r = await protector.onFailure({ req, email: "a@example.com" });
    assert.equal(r.identCount, 1);
    assert.equal(r.cooldownTriggered, null);
  }

  // 2nd failure triggers identity cooldown
  {
    const r = await protector.onFailure({ req, email: "a@example.com" });
    assert.equal(r.identCount, 2);
    assert.equal(r.cooldownTriggered, "identity");
  }

  // check blocks
  {
    const c = await protector.check({ req, email: "a@example.com" });
    assert.equal(c.allowed, false);
    assert.equal((c as any).reason, "identity_cooldown");
  }

  // success resets
  await protector.onSuccess({ req, email: "a@example.com" });
  {
    const c = await protector.check({ req, email: "a@example.com" });
    assert.equal(c.allowed, true);
  }

  // after reset, failures start over
  {
    const r = await protector.onFailure({ req, email: "a@example.com" });
    assert.equal(r.identCount, 1);
  }
});
