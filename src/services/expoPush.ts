import fetchDefault from "node-fetch";
import { ensureSharedRedisClientOrThrow, ensureSharedRedisConnected } from "./sharedRedisClient";
import { env } from "../config/env";

type FetchLike = typeof fetchDefault;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function computeBackoffMs(attempt: number, baseMs: number, maxMs: number) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * Math.min(500, exp * 0.2));
  return Math.min(maxMs, exp + jitter);
}

const INVALID_TOKEN_ERRORS = new Set(["DeviceNotRegistered", "InvalidPushToken"]);
// Expo/FCM/APNs transient-ish signals; docs are not exhaustive, so treat these as retryable.
const TRANSIENT_TICKET_ERRORS = new Set([
  "MessageRateExceeded",
  "ProviderUnavailable",
  "InternalServerError",
  "Timeout",
]);

function extractDetailsError(details: any): string | null {
  const e = details && typeof details === "object" ? (details as any).error : null;
  return typeof e === "string" && e.trim() ? e.trim() : null;
}

async function deletePushTokensBestEffort(prisma: any | undefined, tokens: string[]) {
  const unique = [...new Set(tokens.filter((t) => typeof t === "string" && t.trim()))];
  if (!unique.length) return;
  if (!prisma?.pushToken?.deleteMany) return;
  try {
    await prisma.pushToken.deleteMany({ where: { token: { in: unique } } });
  } catch {
    // ignore
  }
}

async function recordDeadLetterBestEffort(prisma: any | undefined, params: {
  userId?: number | null;
  token: string;
  errorCode?: string | null;
  message?: string | null;
  context?: any;
}) {
  if (!prisma?.securityEvent?.create) return;
  try {
    await prisma.securityEvent.create({
      data: {
        actionType: "push.deadletter",
        actorUserId: params.userId ?? null,
        targetType: "PUSH_TOKEN",
        targetId: params.token,
        metadataJson: {
          errorCode: params.errorCode ?? null,
          message: params.message ?? null,
          context: params.context ?? null,
        },
      },
    });
  } catch {
    // ignore
  }
}

async function checkAndConsumeUserRateBestEffort(opts: {
  userId: number;
  bucket: string;
  windowMs: number;
  limit: number;
}): Promise<{ allowed: boolean; retryAfterSeconds: number | null }> {
  if (opts.limit <= 0) return { allowed: false, retryAfterSeconds: Math.ceil(opts.windowMs / 1000) };

  const redisUrl = (env.RATE_LIMIT_REDIS_URL ?? "").trim();
  if (!redisUrl) return { allowed: true, retryAfterSeconds: null };

  try {
    const client = ensureSharedRedisClientOrThrow();
    await ensureSharedRedisConnected();

    const prefix = env.RATE_LIMIT_REDIS_PREFIX;
    const key = `${prefix}:${opts.bucket}:u:${opts.userId}`;

    const count = await client.incr(key);
    if (count === 1) {
      await client.pExpire(key, opts.windowMs);
    }

    const ttlMs = await client.pTTL(key);
    const retryAfterSeconds = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : Math.ceil(opts.windowMs / 1000);
    if (count > opts.limit) {
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: null };
  } catch {
    // Fail-open.
    return { allowed: true, retryAfterSeconds: null };
  }
}

export type ExpoPushMessage = {
  to: string;
  userId?: number;
  title?: string;
  body?: string;
  data?: Record<string, any>;
  sound?: "default";
  priority?: "default" | "normal" | "high";
};

export function isExpoPushToken(token: string): boolean {
  return typeof token === "string" && (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["));
}

export async function sendExpoPush(
  messages: ExpoPushMessage[],
  opts?: {
    prisma?: any;
    fetch?: FetchLike;
    maxRetries?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    // per-user cap (fail-open when Redis unavailable)
    rateLimit?: {
      enabled?: boolean;
      bucket?: string;
      windowMs?: number;
      limit?: number;
    };
    // when true, record dead-letter rows in SecurityEvent for permanent failures
    deadLetter?: { enabled?: boolean };
  }
): Promise<void> {
  if (!messages.length) return;

  const fetch = opts?.fetch ?? fetchDefault;
  const doSleep = opts?.sleep ?? sleep;

  const maxRetries = Math.max(0, Math.min(10, Number(opts?.maxRetries ?? 3)));
  const retryBaseMs = Math.max(50, Number(opts?.retryBaseMs ?? 400));
  const retryMaxMs = Math.max(retryBaseMs, Number(opts?.retryMaxMs ?? 5_000));

  const rateEnabled = opts?.rateLimit?.enabled ?? true;
  const rateBucket = String(opts?.rateLimit?.bucket ?? "push_send");
  const rateWindowMs = Math.max(1_000, Number(opts?.rateLimit?.windowMs ?? 60_000));
  const rateLimit = Math.max(1, Number(opts?.rateLimit?.limit ?? 20));

  // Filter obviously-invalid tokens and optionally apply per-user caps.
  let pending = messages.filter((m) => isExpoPushToken(m.to));
  if (!pending.length) return;

  if (rateEnabled) {
    const allowed: ExpoPushMessage[] = [];
    for (const m of pending) {
      if (!m.userId) {
        allowed.push(m);
        continue;
      }
      const r = await checkAndConsumeUserRateBestEffort({
        userId: m.userId,
        bucket: rateBucket,
        windowMs: rateWindowMs,
        limit: rateLimit,
      });
      if (r.allowed) {
        allowed.push(m);
      }
    }
    pending = allowed;
    if (!pending.length) return;
  }

  // Expo recommends <=100 messages per request.
  const batches = chunk(pending, 100);
  for (const batch of batches) {
    let attempt = 0;
    let toSend = batch;

    while (toSend.length) {
      attempt += 1;
      let res: any;
      let json: any;

      try {
        res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(
            toSend.map(({ userId: _userId, ...rest }) => rest)
          ),
        });
      } catch (err: any) {
        if (attempt <= maxRetries) {
          const delayMs = computeBackoffMs(attempt, retryBaseMs, retryMaxMs);
          await doSleep(delayMs);
          continue;
        }

        // Permanent failure after retries: dead-letter everything in this send.
        if (opts?.deadLetter?.enabled) {
          await Promise.all(
            toSend.map((m) =>
              recordDeadLetterBestEffort(opts?.prisma, {
                userId: m.userId ?? null,
                token: m.to,
                errorCode: "network_error",
                message: String(err?.message ?? err),
                context: { phase: "send" },
              })
            )
          );
        }
        return;
      }

      if (!res?.ok) {
        const status = Number(res?.status ?? 0);
        const text = await res?.text?.().catch?.(() => "");

        if (isTransientHttpStatus(status) && attempt <= maxRetries) {
          const delayMs = computeBackoffMs(attempt, retryBaseMs, retryMaxMs);
          await doSleep(delayMs);
          continue;
        }

        if (opts?.deadLetter?.enabled) {
          await Promise.all(
            toSend.map((m) =>
              recordDeadLetterBestEffort(opts?.prisma, {
                userId: m.userId ?? null,
                token: m.to,
                errorCode: `http_${status || "unknown"}`,
                message: String(text ?? ""),
                context: { phase: "send" },
              })
            )
          );
        }
        return;
      }

      json = await res.json().catch(() => null);
      const tickets: any[] = Array.isArray(json?.data) ? json.data : [];
      if (!tickets.length) {
        // Unexpected response shape; treat as transient if retries left.
        if (attempt <= maxRetries) {
          const delayMs = computeBackoffMs(attempt, retryBaseMs, retryMaxMs);
          await doSleep(delayMs);
          continue;
        }
        if (opts?.deadLetter?.enabled) {
          await Promise.all(
            toSend.map((m) =>
              recordDeadLetterBestEffort(opts?.prisma, {
                userId: m.userId ?? null,
                token: m.to,
                errorCode: "bad_response",
                message: "Expo push send returned an unexpected response shape.",
                context: { phase: "send" },
              })
            )
          );
        }
        return;
      }

      const invalidTokens: string[] = [];
      const transientRetry: ExpoPushMessage[] = [];
      const ticketIds: string[] = [];
      const idToMessage = new Map<string, ExpoPushMessage>();
      const permanentFailures: Array<{ msg: ExpoPushMessage; code: string | null; message: string | null }> = [];

      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const msg = toSend[i];
        if (!msg) continue;

        if (ticket?.status === "ok" && typeof ticket?.id === "string") {
          ticketIds.push(ticket.id);
          idToMessage.set(ticket.id, msg);
          continue;
        }

        if (ticket?.status === "error") {
          const code = extractDetailsError(ticket?.details);
          const message = typeof ticket?.message === "string" ? ticket.message : null;

          if (code && INVALID_TOKEN_ERRORS.has(code)) {
            invalidTokens.push(msg.to);
            continue;
          }

          if (code && TRANSIENT_TICKET_ERRORS.has(code) && attempt <= maxRetries) {
            transientRetry.push(msg);
            continue;
          }

          permanentFailures.push({ msg, code, message });
          continue;
        }

        // Unknown ticket shape: treat as transient if we can.
        if (attempt <= maxRetries) {
          transientRetry.push(msg);
        } else {
          permanentFailures.push({ msg, code: "unknown_ticket", message: null });
        }
      }

      // Prune invalid/unregistered tokens immediately.
      if (invalidTokens.length) {
        await deletePushTokensBestEffort(opts?.prisma, invalidTokens);
      }

      // Fetch receipts for ok tickets, and prune invalid/unregistered based on receipts.
      if (ticketIds.length) {
        const receiptIdChunks = chunk(ticketIds, 1000);
        for (const ids of receiptIdChunks) {
          let receiptAttempt = 0;
          while (true) {
            receiptAttempt += 1;
            let rr: any;
            try {
              rr = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify({ ids }),
              });
            } catch (err: any) {
              if (receiptAttempt <= maxRetries) {
                const delayMs = computeBackoffMs(receiptAttempt, retryBaseMs, retryMaxMs);
                await doSleep(delayMs);
                continue;
              }
              break;
            }

            if (!rr?.ok) {
              const status = Number(rr?.status ?? 0);
              if (isTransientHttpStatus(status) && receiptAttempt <= maxRetries) {
                const delayMs = computeBackoffMs(receiptAttempt, retryBaseMs, retryMaxMs);
                await doSleep(delayMs);
                continue;
              }
              break;
            }

            const receiptJson = await rr.json().catch(() => null);
            const data = receiptJson?.data && typeof receiptJson.data === "object" ? receiptJson.data : null;
            if (!data) break;

            const invalidFromReceipts: string[] = [];
            const transientFromReceipts: ExpoPushMessage[] = [];
            const permanentFromReceipts: Array<{ msg: ExpoPushMessage; code: string | null; message: string | null }> = [];

            for (const id of ids) {
              const receipt = (data as any)[id];
              const msg = idToMessage.get(id);
              if (!msg) continue;

              if (receipt?.status === "ok") continue;

              if (receipt?.status === "error") {
                const code = extractDetailsError(receipt?.details);
                const message = typeof receipt?.message === "string" ? receipt.message : null;

                if (code && INVALID_TOKEN_ERRORS.has(code)) {
                  invalidFromReceipts.push(msg.to);
                  continue;
                }

                if (code && TRANSIENT_TICKET_ERRORS.has(code) && attempt <= maxRetries) {
                  transientFromReceipts.push(msg);
                  continue;
                }

                permanentFromReceipts.push({ msg, code, message });
              }
            }

            if (invalidFromReceipts.length) {
              await deletePushTokensBestEffort(opts?.prisma, invalidFromReceipts);
            }

            transientRetry.push(...transientFromReceipts);
            permanentFailures.push(...permanentFromReceipts);

            break;
          }
        }
      }

      if (opts?.deadLetter?.enabled && permanentFailures.length) {
        await Promise.all(
          permanentFailures.map((f) =>
            recordDeadLetterBestEffort(opts?.prisma, {
              userId: f.msg.userId ?? null,
              token: f.msg.to,
              errorCode: f.code,
              message: f.message,
              context: { phase: "ticket_or_receipt" },
            })
          )
        );
      }

      // If we have transient per-message failures and retries left, retry only those.
      if (transientRetry.length && attempt <= maxRetries) {
        const delayMs = computeBackoffMs(attempt, retryBaseMs, retryMaxMs);
        await doSleep(delayMs);
        toSend = transientRetry;
        continue;
      }

      // Done with this batch.
      break;
    }
  }
}
