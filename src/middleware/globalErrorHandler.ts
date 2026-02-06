import type { NextFunction, Request, Response } from "express";

type LoggerLike = {
  error: (event: string, meta?: Record<string, any>) => void;
};

type CaptureLike = (err: unknown, context?: Record<string, any>) => void;

function scrub(input: string): string {
  let s = input;

  // Connection strings
  s = s.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DB_URL]");

  // Stripe-ish / webhook secrets
  s = s.replace(/\bsk_(?:live|test)_[A-Za-z0-9]+\b/g, "[REDACTED_STRIPE_SECRET]");
  s = s.replace(/\bpk_(?:live|test)_[A-Za-z0-9]+\b/g, "[REDACTED_STRIPE_PUBLISHABLE]");
  s = s.replace(/\bwhsec_[A-Za-z0-9]+\b/g, "[REDACTED_WEBHOOK_SECRET]");

  // JWT-ish (very rough)
  s = s.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, "[REDACTED_JWT]");

  return s;
}

function getStatus(err: any): number {
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status && status >= 400 && status <= 599) return status;
  return 500;
}

export function createGlobalErrorHandler(deps?: {
  logger?: LoggerLike;
  captureException?: CaptureLike;
}) {
  return function globalErrorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
    const isProd = process.env.NODE_ENV === "production";

    const rawMessage = String(err?.message ?? "");
    let status = getStatus(err);
    if (rawMessage === "CORS blocked") status = 403;

    deps?.logger?.error?.("http.error", {
      reqId: (req as any).id,
      route: String((req as any).originalUrl ?? req.url ?? ""),
      method: req.method,
      status,
      userId: (req as any).user?.userId,
      message: rawMessage,
    });

    deps?.captureException?.(err, {
      reqId: (req as any).id,
      route: String((req as any).originalUrl ?? req.url ?? ""),
      method: req.method,
      status,
      userId: (req as any).user?.userId,
    });

    const safeMessage = status >= 500 ? "Internal server error" : scrub(rawMessage || "Request failed");

    const body: any = { error: safeMessage };
    if (!isProd) {
      body.stack = scrub(String(err?.stack ?? ""));
    }

    res.status(status).json(body);
  };
}

export const globalErrorHandler = createGlobalErrorHandler();
