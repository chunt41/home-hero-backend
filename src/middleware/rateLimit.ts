import rateLimit, { RateLimitRequestHandler, ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

type Role = "CONSUMER" | "PROVIDER" | "ADMIN" | "UNKNOWN";

type ReqWithUser = Request & {
  user?: {
    userId: number;
    role: Role;
  };
};

function keyFor(req: Request): string {
  const r = req as ReqWithUser;

  // Prefer authenticated userId for stable keys
  if (r.user?.userId) return `u:${r.user.userId}`;

  // ✅ Use express-rate-limit's helper for IP normalization (IPv6-safe)
  return `ip:${ipKeyGenerator(req.ip)}`;
}

function roleFor(req: Request): Role {
  const r = req as ReqWithUser;
  return r.user?.role ?? "UNKNOWN";
}

export function roleRateLimit(opts: {
  windowMs: number;
  limits: Partial<Record<Role, number>> & { UNKNOWN: number };
  message?: string;
}): RateLimitRequestHandler {
  const { windowMs, limits, message } = opts;

  return rateLimit({
    windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyFor,
    max: (req: Request) => {
      const role = roleFor(req);
      return limits[role] ?? limits.UNKNOWN;
    },
    message: {
      error: message ?? "Too many requests. Please slow down.",
    },
  });
}
