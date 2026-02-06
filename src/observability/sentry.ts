import { logger } from "../services/logger";

let enabled = false;
let Sentry: any = null;

export async function initSentry() {
  const dsn = (process.env.SENTRY_DSN ?? "").trim();
  if (!dsn) return;

  try {
    // Lazy import so local dev doesn't require Sentry.
    Sentry = await import("@sentry/node");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV,
    });

    enabled = true;
    logger.info("sentry.enabled", { enabled: true });
  } catch (e: any) {
    enabled = false;
    logger.warn("sentry.init_failed", { message: String(e?.message ?? e) });
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!enabled || !Sentry) return;

  try {
    Sentry.captureException(err, { extra: context });
  } catch {
    // ignore
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
