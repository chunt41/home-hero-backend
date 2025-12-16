import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { WebhookDeliveryStatus } from "@prisma/client";


const router = Router();


function normalizeEvents(events: unknown) {
  if (!Array.isArray(events)) return null;
  const cleaned = events
    .map((e) => String(e).trim())
    .filter((e) => e.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeUrl(url: unknown) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * ENDPOINTS
 */


// Test an endpoint (sends a synthetic event immediately)
router.post("/webhooks/endpoints/:id/test", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!endpoint) return res.status(404).json({ error: "Endpoint not found" });

  const event = "webhook.test";
  const payload = {
    message: "Test webhook from GoGetter",
    endpointId: endpoint.id,
    sentAt: new Date().toISOString(),
  };

  const delivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event,
      payload,
      status: WebhookDeliveryStatus.PENDING,
      attempts: 0,
      nextAttempt: new Date(),
      lastError: null,
    },
  });

  res.json({ ok: true, deliveryId: delivery.id });
});

// List endpoints
router.get("/webhooks/endpoints", authMiddleware, requireAdmin, async (_req, res) => {
  const endpoints = await prisma.webhookEndpoint.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(endpoints);
});

// Create endpoint
router.post("/webhooks/endpoints", authMiddleware, requireAdmin, async (req, res) => {
  const { url, secret, enabled = true, events } = req.body as {
    url?: unknown;
    secret?: unknown;
    enabled?: unknown;
    events?: unknown;
  };

  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    return res.status(400).json({ error: "url is required and must be a valid http(s) URL" });
  }

  if (!secret || typeof secret !== "string" || secret.trim().length < 8) {
    return res.status(400).json({ error: "secret is required (min 8 chars)" });
  }

  const normalizedEvents = normalizeEvents(events);
  if (!normalizedEvents) {
    return res.status(400).json({ error: "events must be a non-empty string array" });
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      url: normalizedUrl,
      secret: secret.trim(),
      enabled: Boolean(enabled),
      events: normalizedEvents,
    },
  });

  res.status(201).json(endpoint);
});


// Update endpoint
router.patch("/webhooks/endpoints/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { url, secret, enabled, events } = req.body as {
    url?: unknown;
    secret?: unknown;
    enabled?: unknown;
    events?: unknown;
  };

  const data: any = {};

  if (url !== undefined) {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return res.status(400).json({ error: "url must be a valid http(s) URL" });
    }
    data.url = normalizedUrl;
  }

  if (secret !== undefined) {
    const s = String(secret).trim();
    if (s.length < 8) {
      return res.status(400).json({ error: "secret must be at least 8 characters" });
    }
    data.secret = s;
  }

  if (enabled !== undefined) {
    data.enabled = Boolean(enabled);
  }

  if (events !== undefined) {
    const normalizedEvents = normalizeEvents(events);
    if (!normalizedEvents) {
      return res.status(400).json({ error: "events must be a non-empty string array" });
    }
    data.events = normalizedEvents;
  }

  try {
    const endpoint = await prisma.webhookEndpoint.update({
      where: { id },
      data,
    });

    res.json(endpoint);
  } catch (e: any) {
    // Prisma "record not found" error
    if (e?.code === "P2025") {
      return res.status(404).json({ error: "Endpoint not found" });
    }
    throw e;
  }
});


// Delete endpoint
router.delete("/webhooks/endpoints/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    await prisma.webhookEndpoint.delete({ where: { id } });
    res.json({ ok: true, deleted: id });
  } catch (e: any) {
    if (e?.code === "P2025") {
      return res.status(404).json({ error: "Endpoint not found" });
    }
    throw e;
  }
});


/**
 * DELIVERIES
 */

// List deliveries (filterable)
router.get("/webhooks/deliveries", authMiddleware, requireAdmin, async (req, res) => {
  const status = (req.query.status as string | undefined)?.toUpperCase();
  const endpointId = req.query.endpointId ? Number(req.query.endpointId) : undefined;
  const event = req.query.event ? String(req.query.event) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;

  const where: any = {};
  if (status && ["PENDING", "PROCESSING", "SUCCESS", "FAILED"].includes(status)) {
    where.status = status as WebhookDeliveryStatus;
  }
  if (endpointId && !Number.isNaN(endpointId)) where.endpointId = endpointId;
  if (event) where.event = event;

  const deliveries = await prisma.webhookDelivery.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { endpoint: true },
  });

  res.json(deliveries);
});

// Delivery detail
router.get("/webhooks/deliveries/:id", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id },
    include: { endpoint: true },
  });

  if (!delivery) return res.status(404).json({ error: "Delivery not found" });
  res.json(delivery);
});

// Retry (same delivery)
router.post("/webhooks/deliveries/:id/retry", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await prisma.webhookDelivery.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Delivery not found" });

  await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status: WebhookDeliveryStatus.PENDING,
      lastError: null,
      nextAttempt: new Date(),
    },
  });

  res.json({ ok: true, retried: id });
});

// Replay (new delivery, same payload)
router.post("/webhooks/deliveries/:id/replay", authMiddleware, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { endpointId } = req.body as { endpointId?: number };

  const existing = await prisma.webhookDelivery.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Delivery not found" });

  const newDelivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpointId ?? existing.endpointId,
      event: existing.event,
      payload: existing.payload,
      status: WebhookDeliveryStatus.PENDING,
      attempts: 0,
      nextAttempt: new Date(),
      lastError: null,
    },
  });

  res.json({ ok: true, replayedFrom: id, newDeliveryId: newDelivery.id });
});

export default router;
