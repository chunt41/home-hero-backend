import type { NextFunction, Request, Response } from "express";
import * as crypto from "crypto";
import { logger } from "../services/logger";

function sanitizeRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Keep it bounded and log-safe.
  const clipped = trimmed.slice(0, 64);
  const ok = /^[a-zA-Z0-9._-]+$/.test(clipped);
  return ok ? clipped : null;
}

function routeTemplate(req: Request): string {
  const base = String((req as any).baseUrl ?? "");
  const routePath = (req as any).route?.path;

  if (typeof routePath === "string") return `${base}${routePath}`;

  // Fallback: strip querystring
  const originalUrl = String((req as any).originalUrl ?? req.url ?? "");
  return originalUrl.split("?")[0] || "/";
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const inbound = sanitizeRequestId(req.header("x-request-id"));
  const reqId = inbound ?? crypto.randomUUID();

  req.id = reqId;
  req.requestStart = process.hrtime.bigint();

  res.setHeader("X-Request-Id", reqId);
  next();
}

export function httpAccessLogMiddleware(req: Request, res: Response, next: NextFunction) {
  res.on("finish", () => {
    const start = req.requestStart;
    const durationMs = typeof start === "bigint" ? Number(process.hrtime.bigint() - start) / 1e6 : undefined;

    logger.info("http.request", {
      reqId: req.id,
      route: routeTemplate(req),
      method: req.method,
      status: res.statusCode,
      durationMs: typeof durationMs === "number" ? Math.round(durationMs * 100) / 100 : undefined,
      userId: req.user?.userId,
    });
  });

  next();
}
