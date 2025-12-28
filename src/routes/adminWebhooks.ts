import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import { WebhookDeliveryStatus } from "@prisma/client";
import * as jwt from "jsonwebtoken";

const router = Router();

// List admin notifications (latest 50)
router.get("/notifications", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { user: { role: "ADMIN" } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error("Failed to fetch notifications", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// List admin actions/logs (latest 50)
router.get("/logs", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const logs = await prisma.adminAction.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        admin: { select: { id: true, name: true, email: true } },
        report: { select: { id: true, reason: true, status: true, targetType: true } },
      },
    });
    res.json(logs);
  } catch (err) {
    console.error("Failed to fetch logs", err);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// List users for admin management (with optional search and pagination)
router.get("/users", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { q, skip = 0, take = 50 } = req.query;
    const where: any = {};
    if (q && typeof q === "string" && q.trim()) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: Number(skip),
      take: Math.min(Number(take), 100),
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isSuspended: true,
        createdAt: true,
      },
    });
    res.json(users);
  } catch (err) {
    console.error("Failed to fetch users", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// List flagged jobs (jobs with at least one report)
router.get("/flagged-jobs", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: { reports: { some: {} } },
      include: {
        reports: {
          include: {
            reporter: { select: { id: true, name: true, email: true } },
            handledByAdmin: { select: { id: true, name: true, email: true } },
          },
        },
        consumer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(jobs);
  } catch (err) {
    console.error("Failed to fetch flagged jobs", err);
    res.status(500).json({ error: "Failed to fetch flagged jobs" });
  }
});

// Admin impersonate user: returns a JWT for the target user if admin
router.post("/impersonate/:userId", authMiddleware, requireAdmin, async (req: any, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) return res.status(400).json({ error: "Invalid userId" });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, role: true } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role === "ADMIN") return res.status(403).json({ error: "Cannot impersonate another admin" });

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET" });

  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      impersonatedByAdminId: req.user?.userId,
      isImpersonated: true,
    },
    secret,
    { expiresIn: "1h" }
  );

  res.json({ token });
});

// Admin analytics endpoint: returns time series for users, jobs, revenue
router.get("/analytics", authMiddleware, requireAdmin, async (req, res) => {
  try {
    // Last 30 days
    const days = 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - days + 1);

    // Helper to format date as YYYY-MM-DD
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const range = Array.from({ length: days }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return fmt(d);
    });

    // Users by day
    const users = await prisma.user.findMany({
      where: { createdAt: { gte: start, lte: today } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Jobs by day
    const jobs = await prisma.job.findMany({
      where: { createdAt: { gte: start, lte: today } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Revenue by day (sum of completed StripePayments with status SUCCEEDED)
    const payments = await prisma.stripePayment.findMany({
      where: {
        status: "SUCCEEDED",
        createdAt: { gte: start, lte: today },
      },
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Aggregate by day
    const usersByDay = Object.fromEntries(range.map((d) => [d, 0]));
    users.forEach((u) => {
      const d = fmt(u.createdAt);
      if (usersByDay[d] !== undefined) usersByDay[d] += 1;
    });

    const jobsByDay = Object.fromEntries(range.map((d) => [d, 0]));
    jobs.forEach((j) => {
      const d = fmt(j.createdAt);
      if (jobsByDay[d] !== undefined) jobsByDay[d] += 1;
    });

    const revenueByDay = Object.fromEntries(range.map((d) => [d, 0]));
    payments.forEach((p) => {
      const d = fmt(p.createdAt);
      if (revenueByDay[d] !== undefined) revenueByDay[d] += p.amount;
    });

    res.json({
      range,
      users: usersByDay,
      jobs: jobsByDay,
      revenue: revenueByDay,
    });
  } catch (err) {
    console.error("Failed to fetch analytics", err);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// Admin dashboard stats endpoint
router.get("/stats", authMiddleware, requireAdmin, async (req, res) => {
  try {
    // Total users
    const totalUsers = await prisma.user.count();
    // Providers
    const providers = await prisma.user.count({ where: { role: "PROVIDER" } });
    // Consumers
    const consumers = await prisma.user.count({ where: { role: "CONSUMER" } });
    // Jobs completed
    const jobsCompleted = await prisma.job.count({ where: { status: "COMPLETED" } });
    // Revenue (sum of all completed StripePayments)
    const revenueAgg = await prisma.stripePayment.aggregate({
      _sum: { amount: true },
      where: { status: "SUCCEEDED" },
    });
    const revenue = revenueAgg._sum.amount || 0;
    // Flagged jobs (jobs with at least one report)
    const flaggedJobs = await prisma.job.count({ where: { reports: { some: {} } } });
    // Pending verifications (not implemented, set to 0)
    const pendingVerifications = 0;

    res.json({
      totalUsers,
      providers,
      consumers,
      jobsCompleted,
      revenue,
      flaggedJobs,
      pendingVerifications,
    });
  } catch (err) {
    console.error("Failed to fetch admin stats", err);
    res.status(500).json({ error: "Failed to fetch admin stats" });
  }
});



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
