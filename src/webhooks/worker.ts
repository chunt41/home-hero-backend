// src/webhooks/worker.ts
import * as crypto from "crypto";
import { WebhookDeliveryStatus } from "@prisma/client";
import { prisma } from "../prisma";

const WORKER_POLL_MS = Number(process.env.WEBHOOK_WORKER_POLL_MS ?? 1000);
const BATCH_SIZE = Number(process.env.WEBHOOK_WORKER_BATCH_SIZE ?? 25);
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 10);
const REQUEST_TIMEOUT_MS = Number(process.env.WEBHOOK_REQUEST_TIMEOUT_MS ?? 8000);
const PROCESSING_LEASE_MS = Number(process.env.WEBHOOK_PROCESSING_LEASE_MS ?? 30_000);

function computeBackoffMs(attempts: number) {
  // attempts is 1-based after increment
  // exponential with jitter, capped at 10 minutes
  const base = Math.min(10 * 60_000, 1000 * Math.pow(2, Math.max(0, attempts - 1)));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function sign(secret: string, payload: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function postWithTimeout(url: string, body: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, responseText: text };
  } finally {
    clearTimeout(timer);
  }
}


async function requeueStaleProcessing() {
  const now = new Date();

  // Any PROCESSING row whose lease time has passed should go back to PENDING
  // so it can be claimed again.
  await prisma.webhookDelivery.updateMany({
    where: {
      status: WebhookDeliveryStatus.PROCESSING,
      nextAttempt: { lte: now }, // you're using nextAttempt as the lease timestamp
    },
    data: {
      status: WebhookDeliveryStatus.PENDING,
      // set it eligible immediately
      nextAttempt: now,
      lastError: "Requeued after processing lease expired",
    },
  });
}


/**
 * Claim a batch of deliveries safely.
 * Requires WebhookDeliveryStatus.PROCESSING to exist.
 */
async function claimBatch() {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);

  // Use a transaction so the "find ids" and "claim" are consistent enough.
  // Note: This is "good enough" for single worker instance; for multi-instance
  // it’s still safe because we update by ids and status=PENDING.
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.webhookDelivery.findMany({
      where: {
        status: WebhookDeliveryStatus.PENDING,
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ nextAttempt: null }, { nextAttempt: { lte: now } }],
      },
      orderBy: [{ nextAttempt: "asc" }, { createdAt: "asc" }],
      take: BATCH_SIZE,
      select: { id: true },
    });

    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);

    // Claim them. We guard with status=PENDING so only one worker can claim.
    await tx.webhookDelivery.updateMany({
      where: { id: { in: ids }, status: WebhookDeliveryStatus.PENDING },
      data: {
        status: WebhookDeliveryStatus.PROCESSING,
        attempts: { increment: 1 },
        nextAttempt: leaseUntil, // lease marker
      },
    });

    // Re-read claimed records with endpoint info
    const claimed = await tx.webhookDelivery.findMany({
      where: { id: { in: ids }, status: WebhookDeliveryStatus.PROCESSING },
      include: { endpoint: true },
    });

    return claimed;
  });
}

async function handleOne(delivery: any) {
  const { endpoint } = delivery;

  if (!endpoint?.enabled) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        lastError: "Endpoint disabled",
        nextAttempt: null,
      },
    });

    console.warn(
      `[webhooks] SKIP delivery=${delivery.id} endpoint=${endpoint?.id ?? "none"} event=${delivery.event} reason=disabled`
    );
    return;
  }

  const payloadString = JSON.stringify(delivery.payload ?? {});
  const timestamp = Date.now().toString();

  const signature = sign(endpoint.secret, `${timestamp}.${payloadString}`);

  const headers = {
    "X-GoGetter-Event": delivery.event,
    "X-GoGetter-Delivery-Id": String(delivery.id),
    "X-GoGetter-Timestamp": timestamp,
    "X-GoGetter-Signature": `sha256=${signature}`,
  };

  try {
    const result = await postWithTimeout(endpoint.url, payloadString, headers);

    if (result.ok) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.SUCCESS,
          lastError: null,
          nextAttempt: null,
        },
      });

      console.log(
        `[webhooks] SUCCESS delivery=${delivery.id} endpoint=${endpoint.id} event=${delivery.event} status=${result.status}`
      );
      return;
    }

    const err = `HTTP ${result.status}: ${result.responseText?.slice(0, 500) ?? ""}`;

    console.warn(
      `[webhooks] FAIL delivery=${delivery.id} endpoint=${endpoint.id} event=${delivery.event} err=${err}`
    );

    await failAndReschedule(delivery.id, delivery.attempts, err);
  } catch (e: any) {
    const err = e?.name === "AbortError" ? "Request timeout" : (e?.message ?? "Unknown error");

    console.warn(
      `[webhooks] FAIL delivery=${delivery.id} endpoint=${endpoint.id} event=${delivery.event} err=${err}`
    );

    await failAndReschedule(delivery.id, delivery.attempts, err);
  }
}

async function failAndReschedule(deliveryId: number, attempts: number, lastError: string) {
  const now = new Date();

  if (attempts >= MAX_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        lastError,
        nextAttempt: null,
      },
    });
    return;
  }

  const backoffMs = computeBackoffMs(attempts);
  const nextAttempt = new Date(now.getTime() + backoffMs);

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: WebhookDeliveryStatus.PENDING,
      lastError,
      nextAttempt,
    },
  });
}

export function startWebhookWorker() {
  let stopped = false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const loop = async () => {
    let dbDownBackoffMs = 1000; // start small
    const DB_DOWN_MAX_BACKOFF = 30_000;

    while (!stopped) {
      try {
        await requeueStaleProcessing();

        const batch = await claimBatch();
        for (const delivery of batch) {
          await handleOne(delivery);
        }

        // If we made it here, DB is reachable again → reset backoff
        dbDownBackoffMs = 1000;

        await sleep(WORKER_POLL_MS);
      } catch (e: any) {
        // P1001 = can't reach DB server
        const isDbDown =
          e?.code === "P1001" ||
          String(e?.message ?? "").includes("Can't reach database server");

        console.error("[webhooks] worker loop error:", e?.code ?? "", e?.message ?? e);

        if (isDbDown) {
          // exponential-ish backoff up to 30s
          await sleep(dbDownBackoffMs);
          dbDownBackoffMs = Math.min(DB_DOWN_MAX_BACKOFF, dbDownBackoffMs * 2);
          continue;
        }

        // non-db errors: short delay and continue
        await sleep(1000);
      }
    }
  };

  loop();

  return () => {
    stopped = true;
  };
}
