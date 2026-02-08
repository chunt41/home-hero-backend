import type { NextFunction, Request, Response } from "express";
import * as crypto from "crypto";
import { withLogContext } from "../services/logContext";

function sanitizeCorrelationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Keep it bounded and log-safe.
  const clipped = trimmed.slice(0, 64);
  const ok = /^[a-zA-Z0-9._-]+$/.test(clipped);
  return ok ? clipped : null;
}

function requestPath(req: Request): string {
  const originalUrl = String((req as any).originalUrl ?? req.url ?? "");
  return originalUrl.split("?")[0] || "/";
}

/**
 * Request correlation middleware.
 * - Accepts `X-Correlation-Id` or `X-Request-Id` (sanitized), otherwise generates a UUID.
 * - Sets `req.requestId` (preferred) and `req.id` (legacy), and response `X-Request-Id`.
 * - Establishes AsyncLocalStorage context for structured logging.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const inbound =
    sanitizeCorrelationId(req.header("x-correlation-id")) ??
    sanitizeCorrelationId(req.header("x-request-id"));

  const requestId = inbound ?? crypto.randomUUID();

  (req as any).requestId = requestId;
  (req as any).id = requestId;
  (req as any).requestStart = process.hrtime.bigint();

  res.setHeader("X-Request-Id", requestId);

  withLogContext(
    {
      requestId,
      method: req.method,
      path: requestPath(req),
    },
    () => next()
  );
}
