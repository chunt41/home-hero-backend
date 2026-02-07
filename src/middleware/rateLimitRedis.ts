import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { ensureSharedRedisConnected, ensureSharedRedisClientOrThrow } from "../services/sharedRedisClient";

type Role = "CONSUMER" | "PROVIDER" | "ADMIN" | "UNKNOWN";

type ReqWithUser = Request & {
  user?: {
    userId: number;
    role: Role;
  };
};

export type RedisLike = {
  incr: (key: string) => Promise<number>;
  pExpire: (key: string, ttlMs: number) => Promise<number | boolean>;
  pTTL: (key: string) => Promise<number>;
};

function getRedisUrlOrNull(): string | null {
  const url = (env.RATE_LIMIT_REDIS_URL ?? "").trim();
  return url ? url : null;
}

function ensureClientOrThrow() {
  const url = getRedisUrlOrNull();
  if (!url) {
    throw new Error(
      "RATE_LIMIT_REDIS_URL is not configured (required for Redis-backed rate limiting)."
    );
  }
  return ensureSharedRedisClientOrThrow();
}

function roleFor(req: Request): Role {
  const r = req as ReqWithUser;
  return r.user?.role ?? "UNKNOWN";
}

function stableIdentityFor(req: Request): string {
  const r = req as ReqWithUser;

  if (r.user?.userId) return `u:${r.user.userId}`;

  const ip = String(req.ip ?? "");
  const ua = String(req.get("user-agent") ?? "");

  const digest = crypto
    .createHash("sha256")
    .update(`${ip}|${ua}`, "utf8")
    .digest("base64url");

  return `ipua:${digest}`;
}

export function validateRateLimitRedisStartupOrThrow() {
  if ((process.env.NODE_ENV ?? "development") !== "production") return;

  const url = String(process.env.RATE_LIMIT_REDIS_URL ?? "").trim() || null;
  if (!url) {
    throw new Error(
      "Missing required env var: RATE_LIMIT_REDIS_URL (required in production for rate limiting)."
    );
  }
}

export function createRoleRateLimitRedis(opts: {
  bucket: string;
  windowMs: number;
  limits: Partial<Record<Role, number>> & { UNKNOWN: number };
  message?: string;
  redis?: RedisLike;
  redisPrefix?: string;
}) {
  const {
    bucket,
    windowMs,
    limits,
    message,
    redis: injectedRedis,
    redisPrefix = env.RATE_LIMIT_REDIS_PREFIX,
  } = opts;

  if (!bucket || !bucket.trim()) throw new Error("bucket is required");
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be a positive number");
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const role = roleFor(req);
    const limit = limits[role] ?? limits.UNKNOWN;

    // Allow limit=0 to hard-block.
    if (limit <= 0) {
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: message ?? "Too many requests. Please slow down.",
      });
    }

    try {
      const identity = stableIdentityFor(req);
      const key = `${redisPrefix}:${bucket}:${identity}`;

      const redis: RedisLike =
        injectedRedis ??
        (() => {
          const client = ensureClientOrThrow();
          // node-redis methods are camelCase; adapt to RedisLike
          return {
            incr: async (k: string) => {
              await ensureSharedRedisConnected();
              return client.incr(k);
            },
            pExpire: async (k: string, ttlMs: number) => {
              await ensureSharedRedisConnected();
              return client.pExpire(k, ttlMs);
            },
            pTTL: async (k: string) => {
              await ensureSharedRedisConnected();
              return client.pTTL(k);
            },
          };
        })();

      const count = await redis.incr(key);
      if (count === 1) {
        await redis.pExpire(key, windowMs);
      }

      const ttlMs = await redis.pTTL(key);
      const resetSeconds =
        ttlMs > 0 ? Math.ceil(ttlMs / 1000) : Math.ceil(windowMs / 1000);

      const remaining = Math.max(0, limit - count);

      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(resetSeconds));

      if (count > limit) {
        res.setHeader("Retry-After", String(resetSeconds));
        return res.status(429).json({
          error: message ?? "Too many requests. Please slow down.",
        });
      }

      return next();
    } catch (err) {
      // Fail-open to preserve availability if Redis is down.
      return next();
    }
  };
}
