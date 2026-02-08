import { logger } from "../services/logger";
import { getLogContext } from "../services/logContext";
import { scrubAny, scrubSentryEvent } from "./sentryScrubber";

type SentryLike = any;

let enabled = false;
let Sentry: SentryLike = null;

export async function initSentry() {
  const dsn = (process.env.SENTRY_DSN ?? "").trim();
  if (!dsn) return;

  try {
    // Lazy import so local dev doesn't require Sentry.
    Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV,
      beforeSend: (event: any) => scrubSentryEvent(event),
    });

    enabled = true;
    logger.info("sentry.enabled", { enabled: true });
  } catch (e: any) {
    enabled = false;
    logger.warn("sentry.init_failed", { message: String(e?.message ?? e) });
  }
}

export function setSentryRequestTags(tags: { requestId?: string; route?: string; userId?: number; role?: string }) {
  if (!enabled || !Sentry) return;

  try {
    const scope = Sentry.getCurrentScope?.();
    if (!scope) return;

    if (tags.requestId) scope.setTag("requestId", String(tags.requestId));
    if (tags.route) scope.setTag("route", String(tags.route));
    if (typeof tags.userId === "number") scope.setTag("userId", String(tags.userId));
    if (tags.role) scope.setTag("role", String(tags.role));
  } catch {
    // ignore
  }
}

export function setSentryUser(user: { userId: number; role?: string } | null) {
  if (!enabled || !Sentry) return;
  if (!user) return;

  try {
    const scope = Sentry.getCurrentScope?.();
    if (!scope) return;
    scope.setUser({ id: String(user.userId) });
    if (user.role) scope.setTag("role", String(user.role));
    scope.setTag("userId", String(user.userId));
  } catch {
    // ignore
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!enabled || !Sentry) return;

  try {
    const ctx = getLogContext();

    const apply = (scope: any) => {
      const requestId = ctx?.requestId ?? (context as any)?.requestId;
      if (requestId) scope.setTag?.("requestId", String(requestId));
      if (ctx?.path) scope.setTag?.("route", String(ctx.path));
      if (ctx?.method) scope.setTag?.("method", String(ctx.method));
      if (typeof ctx?.userId === "number") {
        scope.setTag?.("userId", String(ctx.userId));
        scope.setUser?.({ id: String(ctx.userId) });
      }
      if (typeof ctx?.jobId === "number") scope.setTag?.("jobId", String(ctx.jobId));
      if (typeof ctx?.jobType === "string") scope.setTag?.("jobType", String(ctx.jobType));
      if (typeof ctx?.webhookDeliveryId === "number") scope.setTag?.("webhookDeliveryId", String(ctx.webhookDeliveryId));
      if (typeof ctx?.webhookAttemptId === "number") scope.setTag?.("webhookAttemptId", String(ctx.webhookAttemptId));

      if (context) {
        scope.setContext?.("extra", scrubAny(context) as any);
      }
    };

    if (typeof Sentry.withScope === "function") {
      Sentry.withScope((scope: any) => {
        apply(scope);
        Sentry.captureException(err);
      });
      return;
    }

    const scope = Sentry.getCurrentScope?.();
    if (scope) apply(scope);
    Sentry.captureException(err, context ? { extra: scrubAny(context) } : undefined);
  } catch {
    // ignore
  }
}

export function captureMessage(
  message: string,
  context?: Record<string, unknown> & { level?: "fatal" | "error" | "warning" | "info" | "debug" }
): boolean {
  if (!enabled || !Sentry) return false;

  try {
    const ctx = getLogContext();

    const apply = (scope: any) => {
      const requestId = ctx?.requestId ?? (context as any)?.requestId;
      if (requestId) scope.setTag?.("requestId", String(requestId));
      if (ctx?.path) scope.setTag?.("route", String(ctx.path));
      if (ctx?.method) scope.setTag?.("method", String(ctx.method));
      if (typeof ctx?.userId === "number") {
        scope.setTag?.("userId", String(ctx.userId));
        scope.setUser?.({ id: String(ctx.userId) });
      }
      if (typeof ctx?.jobId === "number") scope.setTag?.("jobId", String(ctx.jobId));
      if (typeof ctx?.jobType === "string") scope.setTag?.("jobType", String(ctx.jobType));
      if (typeof ctx?.webhookDeliveryId === "number") scope.setTag?.("webhookDeliveryId", String(ctx.webhookDeliveryId));
      if (typeof ctx?.webhookAttemptId === "number") scope.setTag?.("webhookAttemptId", String(ctx.webhookAttemptId));

      if (context) {
        const { level, ...rest } = context as any;
        if (level) scope.setLevel?.(level);
        scope.setContext?.("extra", scrubAny(rest) as any);
      }
    };

    if (typeof Sentry.withScope === "function") {
      Sentry.withScope((scope: any) => {
        apply(scope);
        Sentry.captureMessage(message);
      });
      return true;
    }

    const scope = Sentry.getCurrentScope?.();
    if (scope) apply(scope);
    Sentry.captureMessage(message);
    return true;
  } catch {
    return false;
  }
}

export async function flushSentry(timeoutMs = 1500) {
  if (!enabled || !Sentry) return;

  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // ignore
  }
}
