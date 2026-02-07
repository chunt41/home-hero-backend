import type { Request } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { ensureSharedRedisConnected } from "./sharedRedisClient";

export type RedisKV = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { PX?: number }) => Promise<unknown>;
  del: (key: string) => Promise<number>;
  incr: (key: string) => Promise<number>;
  pExpire: (key: string, ttlMs: number) => Promise<number | boolean>;
  pTTL: (key: string) => Promise<number>;
};

type LoginBruteForcePolicy = {
  windowMs: number;
  cooldownMs: number;
  maxFailuresPerIp: number;
  maxFailuresPerIdentity: number;
};

function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("base64url");
}

function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

async function ensureRedis(): Promise<RedisKV> {
  const client = await ensureSharedRedisConnected();
  return client as unknown as RedisKV;
}

function defaultPolicy(): LoginBruteForcePolicy {
  const windowMs = Number(process.env.LOGIN_BRUTE_FORCE_WINDOW_MS ?? 15 * 60_000);
  const cooldownMs = Number(process.env.LOGIN_BRUTE_FORCE_COOLDOWN_MS ?? 10 * 60_000);
  const maxFailuresPerIp = Number(process.env.LOGIN_BRUTE_FORCE_MAX_FAILS_IP ?? 25);
  const maxFailuresPerIdentity = Number(process.env.LOGIN_BRUTE_FORCE_MAX_FAILS_EMAIL ?? 8);

  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 15 * 60_000,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 10 * 60_000,
    maxFailuresPerIp:
      Number.isFinite(maxFailuresPerIp) && maxFailuresPerIp > 0 ? maxFailuresPerIp : 25,
    maxFailuresPerIdentity:
      Number.isFinite(maxFailuresPerIdentity) && maxFailuresPerIdentity > 0 ? maxFailuresPerIdentity : 8,
  };
}

function ipFor(req: Request): string {
  return String(req.ip ?? "").trim() || "unknown";
}

function keyPrefix(): string {
  return String(env.RATE_LIMIT_REDIS_PREFIX ?? "rl").trim() || "rl";
}

function emailIdentityKey(email: string): string {
  const em = normalizeEmail(email);
  return `e:${sha256Base64Url(em)}`;
}

export function createLoginBruteForceProtector(opts?: {
  redis?: RedisKV;
  policy?: Partial<LoginBruteForcePolicy>;
  prefix?: string;
}) {
  const policy: LoginBruteForcePolicy = {
    ...defaultPolicy(),
    ...(opts?.policy ?? {}),
  };

  const prefix = (opts?.prefix ?? keyPrefix()).trim() || "rl";

  async function getRedis(): Promise<RedisKV> {
    if (opts?.redis) return opts.redis;
    return ensureRedis();
  }

  function keys(params: { req: Request; email: string }) {
    const ip = ipFor(params.req);
    const ident = emailIdentityKey(params.email);

    return {
      ipFail: `${prefix}:auth_login:ip:${ip}:fail`,
      ipCooldown: `${prefix}:auth_login:ip:${ip}:cooldown`,
      identFail: `${prefix}:auth_login:ident:${ident}:fail`,
      identCooldown: `${prefix}:auth_login:ident:${ident}:cooldown`,
    };
  }

  async function ttlSeconds(redis: RedisKV, key: string, fallbackMs: number): Promise<number> {
    const ttlMs = await redis.pTTL(key);
    if (ttlMs > 0) return Math.ceil(ttlMs / 1000);
    return Math.ceil(fallbackMs / 1000);
  }

  return {
    policy,

    async check(params: { req: Request; email: string }) {
      const redis = await getRedis();
      const k = keys(params);

      const [ipCd, identCd] = await Promise.all([
        redis.get(k.ipCooldown),
        redis.get(k.identCooldown),
      ]);

      if (ipCd) {
        return {
          allowed: false as const,
          reason: "ip_cooldown" as const,
          retryAfterSeconds: await ttlSeconds(redis, k.ipCooldown, policy.cooldownMs),
        };
      }

      if (identCd) {
        return {
          allowed: false as const,
          reason: "identity_cooldown" as const,
          retryAfterSeconds: await ttlSeconds(redis, k.identCooldown, policy.cooldownMs),
        };
      }

      return { allowed: true as const };
    },

    async onFailure(params: { req: Request; email: string }) {
      const redis = await getRedis();
      const k = keys(params);

      const [ipCount, identCount] = await Promise.all([
        redis.incr(k.ipFail),
        redis.incr(k.identFail),
      ]);

      if (ipCount === 1) await redis.pExpire(k.ipFail, policy.windowMs);
      if (identCount === 1) await redis.pExpire(k.identFail, policy.windowMs);

      let cooldownTriggered: "ip" | "identity" | null = null;

      if (ipCount >= policy.maxFailuresPerIp) {
        await redis.set(k.ipCooldown, "1", { PX: policy.cooldownMs });
        cooldownTriggered = "ip";
      }

      if (identCount >= policy.maxFailuresPerIdentity) {
        await redis.set(k.identCooldown, "1", { PX: policy.cooldownMs });
        cooldownTriggered = cooldownTriggered ?? "identity";
      }

      return {
        ipCount,
        identCount,
        cooldownTriggered,
      };
    },

    async onSuccess(params: { req: Request; email: string }) {
      const redis = await getRedis();
      const k = keys(params);

      await redis.del(k.identFail);
      await redis.del(k.identCooldown);
      await redis.del(k.ipFail);
      await redis.del(k.ipCooldown);

      return { ok: true };
    },
  };
}
