import cors from "cors";
import * as dotenv from "dotenv";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { prisma } from "./prisma";
import express = require("express");
import type { Request, Response, NextFunction } from "express";
import { AdminActionType } from "@prisma/client";
import { roleRateLimit } from "./middleware/rateLimit";
import * as crypto from "crypto";
import fetch from "node-fetch";
import { startWebhookWorker } from "./webhooks/worker";
import { authMiddleware } from "./middleware/authMiddleware";
import { env } from "./config/env";

let webhookWorkerStartedAt: Date | null = null;

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
  isSuspended: boolean;               // ✅ required
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  impersonatedByAdminId?: number;
  isImpersonated?: boolean;
};



async function deliverWebhook(params: {
  deliveryId: number;
  url: string;
  secret: string;
  event: string;
  payload: any;
}) {
  const { deliveryId, url, secret, event, payload } = params;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const rawBody = JSON.stringify(payload);

  // Canonical base string (VERSIONED)
  const baseString = `v1.${timestamp}.${event}.${rawBody}`;

  const signatureHex = crypto
    .createHmac("sha256", secret)
    .update(baseString, "utf8")
    .digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GoGetter-Delivery-Id": String(deliveryId),
      "X-GoGetter-Event": event,
      "X-GoGetter-Timestamp": timestamp,
      "X-GoGetter-Signature": `v1=${signatureHex}`,
    },
    body: rawBody,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook failed: ${res.status} ${text}`);
  }
}


// Augment the Request type so we can attach user info from JWT
export interface AuthRequest extends Request {
  user?: AuthUser;
}


if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const app = express();
app.set("etag", false);
const PORT = env.PORT;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// --- Middlewares ---
const allowedOrigins =
  (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

app.use((err: any, _req: Request, res: Response, _next: any) => {
  if (err?.message === "CORS blocked") {
    return res.status(403).json({ ok: false, error: "CORS blocked" });
  }
  return res.status(500).json({ ok: false, error: "Server error" });
});


app.use(
  cors({
    origin: (origin, cb) => {
      // allow tools like curl/postman (no origin)
      if (!origin) return cb(null, true);

      // dev: allow localhost automatically
      if ((process.env.NODE_ENV ?? "development") !== "production") {
        if (origin.includes("localhost")) return cb(null, true);
      }

      // production: only allow configured origins
      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);


import adminWebhooksRouter from "./routes/adminWebhooks";
app.use("/admin", adminWebhooksRouter);



function timingSafeEqualHex(a: string, b: string) {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifyGoGetterWebhook(secret: string, toleranceSeconds = 300) {
  return (req: any, res: any, next: any) => {
    const deliveryId = req.header("X-GoGetter-Delivery-Id");
    const event = req.header("X-GoGetter-Event");
    const timestamp = req.header("X-GoGetter-Timestamp");
    const sigHeader = req.header("X-GoGetter-Signature");

    if (!deliveryId || !event || !timestamp || !sigHeader) {
      return res.status(400).json({ error: "Missing webhook headers." });
    }

    const match = /^v1=([0-9a-f]{64})$/i.exec(sigHeader);
    if (!match) return res.status(400).json({ error: "Invalid signature format." });

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return res.status(400).json({ error: "Invalid timestamp." });

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSeconds) {
      return res.status(400).json({ error: "Webhook timestamp outside tolerance." });
    }

    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const baseString = `v1.${timestamp}.${event}.${rawBody}`;
    const expected = crypto.createHmac("sha256", secret).update(baseString, "utf8").digest("hex");

    if (!timingSafeEqualHex(expected, match[1])) {
      return res.status(401).json({ error: "Invalid signature." });
    }

    // attach for handlers
    req.webhook = { deliveryId, event, timestamp: ts };

    return next();
  };
}

const loginLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 10, PROVIDER: 10, ADMIN: 30 },
  message: "Too many login attempts. Try again in a minute.",
});

const signupLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 5, PROVIDER: 5, ADMIN: 10 },
  message: "Too many signup attempts. Try again in a minute.",
});

const messageLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 30, PROVIDER: 45, ADMIN: 200 },
  message: "Too many messages in a short time. Please slow down.",
});

const bidLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 0, PROVIDER: 15, ADMIN: 100 },
  message: "Too many bids in a short time. Please slow down.",
});

const reportLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 5, PROVIDER: 5, ADMIN: 200 },
  message: "Too many reports in a short time. Please slow down.",
});

const notificationsLimiter = roleRateLimit({
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 60, PROVIDER: 60, ADMIN: 300 },
  message: "Too many notification refreshes. Please slow down.",
});


// --- Auth middleware (allows suspended users; used ONLY for /me) ---
const authAllowSuspended = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "Invalid Authorization header format" });
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET) as { userId: number; role: string };

    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        role: true,
        isSuspended: true,
        suspendedAt: true,
        suspendedReason: true,
      },
    });

    if (!dbUser) return res.status(401).json({ error: "User not found for token" });

    req.user = {
      userId: dbUser.id,
      role: dbUser.role,
      isSuspended: dbUser.isSuspended,
      suspendedAt: dbUser.suspendedAt,
      suspendedReason: dbUser.suspendedReason,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// --- Notification helper ---
// Simple wrapper so we don't repeat prisma.notification.create everywhere
async function createNotification(params: {
  userId: number;
  type: string;
  content: string;
}) {
  const { userId, type, content } = params;
  try {
    await prisma.notification.create({
      data: {
        userId,
        type,
        content,
      },
    });
  } catch (err) {
    console.error("Error creating notification:", err);
    // We don't throw, because we don't want a notification failure
    // to break the main action (placing a bid, sending a message, etc.)
  }
}

// Simple pricing function for subscription tiers (amount in cents)
function getSubscriptionPriceCents(tier: "FREE" | "BASIC" | "PRO"): number {
  switch (tier) {
    case "BASIC":
      return 500; // $5.00
    case "PRO":
      return 1000; // $10.00
    case "FREE":
    default:
      return 0;
  }
}

function parsePositiveInt(value: unknown, fallback: number, max?: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const i = Math.floor(n);
  if (max != null) return Math.min(i, max);
  return i;
}

function parseOptionalCursorId(value: unknown) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function signWebhookPayload(secret: string, payload: any, timestamp: number) {
  const body = JSON.stringify(payload);
  const signed = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, signature: signed };
}

// --- Webhook helper ---
// Finds endpoints subscribed to an eventType and creates delivery rows for async processing.
async function enqueueWebhookEvent(args: { eventType: string; payload: Record<string, any> }) {
  const { eventType, payload } = args;

  console.log("[WEBHOOK enqueue]", eventType); // ✅ TEMP

  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { enabled: true, events: { has: eventType } },
      select: { id: true },
    });

    console.log("[WEBHOOK endpoints matched]", endpoints.length); // ✅ TEMP

    if (endpoints.length === 0) return;

    await prisma.webhookDelivery.createMany({
      data: endpoints.map((e) => ({
        endpointId: e.id,
        event: eventType,
        payload,
        status: "PENDING",
        attempts: 0,
        nextAttempt: new Date(),
      })),
    });

    console.log("[WEBHOOK deliveries created]", endpoints.length); // ✅ TEMP
  } catch (err) {
    console.error("Failed to enqueue webhook event:", eventType, err);
  }
}

function computeNextAttempt(attempts: number) {
  // simple exponential-ish backoff: 30s, 60s, 120s, 240s...
  const base = Number(process.env.WEBHOOK_RETRY_SECONDS ?? 30);
  const delaySeconds = base * Math.pow(2, Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}


// Recompute and update a provider's average rating + review count
async function recomputeProviderRating(providerId: number) {
  // 1) Aggregate over all reviews for this provider
  const agg = await prisma.review.aggregate({
    where: { providerId },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const avgRating = agg._avg.rating ?? null;
  const totalReviews = agg._count._all ?? 0;

  // 2) Upsert ProviderProfile in case it somehow doesn't exist yet
  await prisma.providerProfile.upsert({
    where: { providerId },
    update: {
      rating: avgRating,
      reviewCount: totalReviews,
    },
    create: {
      providerId,
      rating: avgRating,
      reviewCount: totalReviews,
    },
  });

  return {
    averageRating: avgRating,
    reviewCount: totalReviews,
  };
}

const DEFAULT_CATEGORIES = [
  { name: "Handyman", slug: "handyman" },
  { name: "Electrician", slug: "electrician" },
  { name: "Plumber", slug: "plumber" },
  { name: "Cleaner", slug: "cleaner" },
  { name: "Painter", slug: "painter" },
];

async function seedCategories() {
  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: cat,
    });
  }
}

// Check if either user has blocked the other
async function isBlockedBetween(userAId: number, userBId: number): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userAId, blockedId: userBId },
        { blockerId: userBId, blockedId: userAId },
      ],
    },
  });

  return !!block;
}

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }

  // 🚫 Impersonated sessions are NEVER allowed admin access
  if (req.user.isImpersonated) {
    res.status(403).json({
      error: "Admin access not allowed while impersonating a user.",
    });
    return false;
  }

  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "Admin access only." });
    return false;
  }

  return true;
}


async function logAdminAction(args: {
  adminId: number;
  type: AdminActionType;
  reportId?: number | null;
  entityId?: number | null;
  notes?: string | null;
}) {
  const { adminId, type, reportId = null, entityId = null, notes = null } = args;

  return prisma.adminAction.create({
    data: {
      adminId,
      type,
      reportId,
      entityId,
      notes,
    },
  });
}

function isAdmin(req: AuthRequest) {
  return req.user?.role === "ADMIN";
}

function visibilityFilters(req: AuthRequest) {
  // Only restrict visibility for non-admins
  if (isAdmin(req)) {
    return {
      userWhereVisible: {},
      jobWhereVisible: {},
      messageWhereVisible: {},
    };
  }

  return {
    // Users visible to the public
    userWhereVisible: {
      isSuspended: false,
    },

    // Jobs visible to the public
    jobWhereVisible: {
      isHidden: false,
      consumer: { isSuspended: false },
    },

    // Messages visible to the public
    messageWhereVisible: {
      isHidden: false,
    },
  };
}

const processed = new Set<string>(); // replace with DB table in real usage

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "home-hero-backend",
    env: process.env.NODE_ENV ?? "development",
    time: new Date().toISOString(),
  });
});


app.get("/health/db", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      ok: true,
      db: "up",
      time: new Date().toISOString(),
    });
  } catch (e: any) {
    return res.status(503).json({
      ok: false,
      db: "down",
      error: e?.message ?? String(e),
      time: new Date().toISOString(),
    });
  }
});

app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      db: "ok",
      worker: webhookWorkerStartedAt ? "running" : "unknown",
      workerStartedAt: webhookWorkerStartedAt?.toISOString() ?? null,
      time: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(503).json({
      ok: false,
      db: "down",
      error: e?.message ?? String(e),
      time: new Date().toISOString(),
    });
  }
});


app.post("/webhooks/gogetter", verifyGoGetterWebhook(process.env.GOGETTER_WEBHOOK_SECRET!), (req: any, res: any) => {
  const { deliveryId, event } = req.webhook;

  // idempotency: safe replays
  if (processed.has(deliveryId)) return res.status(200).json({ ok: true, deduped: true });
  processed.add(deliveryId);

  // handle events
  switch (event) {
    case "thread.read":
      // do stuff with req.body
      break;
    case "notification.read":
      break;
  }

  return res.status(200).json({ ok: true });
});

// GET /categories → list all provider categories
app.get("/categories", async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    return res.json(
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
      }))
    );
  } catch (err) {
    console.error("GET /categories error:", err);
    return res.status(500).json({
      error: "Internal server error while fetching categories.",
    });
  }
});


// TEMP: seed categories (call once, then comment out/remove)
app.post("/dev/seed-categories", async (req: Request, res: Response) => {
  try {
    await seedCategories();
    return res.json({ message: "Categories seeded." });
  } catch (err) {
    console.error("seedCategories error:", err);
    return res.status(500).json({ error: "Failed to seed categories." });
  }
});




// --- Health check ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "GoGetter API is running 🚀" });
});

// GET /me  → current user's info (should work even if suspended)
app.get("/me", authAllowSuspended, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const me = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        subscription: true,
        providerProfile: true,
      },
    });

    if (!me) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      id: me.id,
      role: me.role,
      name: me.name,
      email: me.email,
      phone: me.phone,
      location: me.location,
      createdAt: me.createdAt,

      // ✅ suspension fields so the frontend can show the banner
      isSuspended: me.isSuspended,
      suspendedAt: me.suspendedAt,
      suspendedReason: me.suspendedReason,

      subscription: me.subscription
        ? {
            tier: me.subscription.tier,
            renewsAt: me.subscription.renewsAt,
            createdAt: me.subscription.createdAt,
          }
        : null,

      // optional: provider profile fields (if provider)
      providerProfile: me.providerProfile
        ? {
            experience: me.providerProfile.experience,
            specialties: me.providerProfile.specialties,
            rating: me.providerProfile.rating,
            reviewCount: me.providerProfile.reviewCount,
          }
        : null,
    });
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ error: "Internal server error while fetching /me." });
  }
});


// -----------------------------
// Subscription endpoints
// -----------------------------

// --- Subscription: get my current subscription + bid usage ---
// GET /subscription
app.get("/subscription", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // 1) Find the user and their subscription
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { subscription: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const tier = user.subscription?.tier || "FREE";

    // 2) For FREE tier, compute bids used in last 30 days
    let bidsUsedLast30Days: number | null = null;
    let bidLimitPer30Days: number | null = null;
    let remainingBids: number | null = null;

    if (tier === "FREE" && req.user.role === "PROVIDER") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const bidsLast30 = await prisma.bid.count({
        where: {
          providerId: req.user.userId,
          createdAt: { gte: thirtyDaysAgo },
        },
      });

      bidLimitPer30Days = 5;
      bidsUsedLast30Days = bidsLast30;
      remainingBids = Math.max(0, bidLimitPer30Days - bidsLast30);
    }

    return res.json({
      userId: user.id,
      role: user.role,
      tier,
      bidLimitPer30Days,
      bidsUsedLast30Days,
      remainingBids,
    });
  } catch (err) {
    console.error("GET /subscription error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching subscription." });
  }
});


// POST /subscription/upgrade
// Body: { tier: "BASIC" | "PRO" }
app.post("/subscription/upgrade", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Only providers can upgrade
    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can upgrade subscriptions." });
    }

    const { tier } = req.body as { tier?: "FREE" | "BASIC" | "PRO" };

    if (!tier || (tier !== "BASIC" && tier !== "PRO")) {
      return res.status(400).json({
        error: "tier is required and must be either BASIC or PRO for upgrade.",
      });
    }

    const userId = req.user.userId;

    // Capture previous tier for webhook payload
    const existing = await prisma.subscription.findUnique({
      where: { userId },
      select: { id: true, tier: true, renewsAt: true },
    });
    const previousTier = existing?.tier ?? "FREE";

    // Price + renewal
    const amountCents = getSubscriptionPriceCents(tier);
    const now = new Date();
    const renewsAt = new Date(now);
    renewsAt.setMonth(renewsAt.getMonth() + 1);

    // Transaction: subscription + payment consistent
    const { subscription, payment } = await prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.upsert({
        where: { userId },
        update: { tier, renewsAt },
        create: { userId, tier, renewsAt },
      });

      const payment = await tx.subscriptionPayment.create({
        data: {
          userId,
          subscriptionId: subscription.id,
          tier,
          amount: amountCents,
          status: "SUCCEEDED",
        },
      });

      return { subscription, payment };
    });

    // Webhook events (after successful commit)
    await enqueueWebhookEvent({
      eventType: "subscription.upgraded",
      payload: {
        userId,
        previousTier,
        newTier: tier,
        subscriptionId: subscription.id,
        renewsAt: subscription.renewsAt,
      },
    });

    await enqueueWebhookEvent({
      eventType: "subscription.payment_recorded",
      payload: {
        userId,
        paymentId: payment.id,
        subscriptionId: subscription.id,
        tier,
        amount: payment.amount,
        status: payment.status,
        createdAt: payment.createdAt,
      },
    });

    return res.json({
      message: "Subscription upgraded and payment recorded.",
      subscription,
      payment,
    });
  } catch (err) {
    console.error("POST /subscription/upgrade error:", err);
    return res.status(500).json({ error: "Internal server error while upgrading subscription." });
  }
});

// POST /subscription/downgrade  → set my tier back to FREE
// (Optionally: you could allow body { "tier": "FREE" }, but we'll just force FREE.)
app.post("/subscription/downgrade", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can change subscriptions." });
    }

    const userId = req.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const previousTier = user.subscription?.tier ?? "FREE";

    const subscription = await prisma.subscription.upsert({
      where: { userId },
      update: { tier: "FREE", renewsAt: null },
      create: { userId, tier: "FREE", renewsAt: null },
    });

    // Webhook event
    await enqueueWebhookEvent({
      eventType: "subscription.downgraded",
      payload: {
        userId,
        previousTier,
        newTier: "FREE",
        subscriptionId: subscription.id,
        renewsAt: subscription.renewsAt,
      },
    });

    return res.json({
      message: "Subscription downgraded to FREE.",
      subscription: {
        tier: subscription.tier,
        renewsAt: subscription.renewsAt,
        createdAt: subscription.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /subscription/downgrade error:", err);
    return res.status(500).json({ error: "Internal server error while downgrading subscription." });
  }
});

// GET /payments/subscriptions → list subscription payments for current user
app.get(
  "/payments/subscriptions",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const payments = await prisma.subscriptionPayment.findMany({
        where: { userId: req.user.userId },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        payments.map((p) => ({
          id: p.id,
          tier: p.tier,
          amount: p.amount,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }))
      );
    } catch (err) {
      console.error("GET /payments/subscriptions error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching subscription payments.",
      });
    }
  }
);


// --- AUTH: SIGNUP ---
// POST /auth/signup
// Body: { role, name, email, password, phone?, location? }
app.post("/auth/signup", signupLimiter, async (req, res) => {
  try {
    const { role, name, email, password, phone, location } = req.body;

    // Basic validation
    if (!role || !name || !email || !password) {
      return res.status(400).json({
        error: "role, name, email, and password are required.",
      });
    }

    if (role !== "CONSUMER" && role !== "PROVIDER") {
      return res.status(400).json({
        error: "role must be CONSUMER or PROVIDER.",
      });
    }

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return res.status(409).json({
        error: "A user with this email already exists.",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user + subscription (+ provider profile if needed)
    const user = await prisma.user.create({
      data: {
        role, // "CONSUMER" or "PROVIDER"
        name,
        email,
        passwordHash,
        phone,
        location,
        subscription: {
          create: {
            tier: "FREE",
          },
        },
        ...(role === "PROVIDER"
          ? {
              providerProfile: {
                create: {},
              },
            }
          : {}),
      },
      include: {
        subscription: true,
        providerProfile: true,
      },
    });

    // ✅ Webhook event (after user is created)
    // Keep payload non-sensitive (no passwordHash, no raw password).
    await enqueueWebhookEvent({
      eventType: "user.signed_up",
      payload: {
        userId: user.id,
        role: user.role,
        name: user.name,
        email: user.email, // if you prefer less PII, remove this and rely on userId only
        phone: user.phone ?? null,
        location: user.location ?? null,
        subscriptionTier: user.subscription?.tier ?? "FREE",
        createdAt: user.createdAt,
      },
    });

    // Create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        subscriptionTier: user.subscription?.tier ?? "FREE",
      },
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Internal server error during signup." });
  }
});

// --- AUTH: LOGIN ---
// POST /auth/login
// Body: { email, password }
app.post("/auth/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "email and password are required.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { subscription: true },
    });

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        subscriptionTier: user.subscription?.tier ?? "FREE",
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error during login." });
  }
});

// --- Jobs: create job (CONSUMER only) ---
// POST /jobs
// Body: { title, description, budgetMin?, budgetMax?, location? }
app.post("/jobs", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can create jobs" });
    }

    const { title, description, budgetMin, budgetMax, location } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: "title and description are required." });
    }

    const job = await prisma.job.create({
      data: {
        title,
        description,
        budgetMin: budgetMin ?? null,
        budgetMax: budgetMax ?? null,
        location: location ?? null,
        consumerId: req.user.userId,
        status: "OPEN",
      },
    });

    // ✅ enqueue webhook
    await enqueueWebhookEvent({
      eventType: "job.created",
      payload: {
        jobId: job.id,
        consumerId: job.consumerId,
        title: job.title,
        location: job.location,
        status: job.status,
        budgetMin: job.budgetMin,
        budgetMax: job.budgetMax,
        createdAt: job.createdAt,
      },
    });

    return res.status(201).json({
      id: job.id,
      title: job.title,
      description: job.description,
      budgetMin: job.budgetMin,
      budgetMax: job.budgetMax,
      location: job.location,
      status: job.status,
      createdAt: job.createdAt,
    });
  } catch (err) {
    console.error("Create job error:", err);
    return res.status(500).json({ error: "Internal server error while creating job." });
  }
});


// GET /jobs/browse
// Query params:
//   q?: string
//   location?: string
//   cursor?: number (jobId)
//   limit?: number (default 20, max 50)
app.get("/jobs/browse", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { q, location, cursor, limit } = req.query as {
      q?: string;
      location?: string;
      cursor?: string;
      limit?: string;
    };

    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const take = parsePositiveInt(limit, 20, 50);
    const cursorId = parseOptionalCursorId(cursor);

    const { jobWhereVisible } = visibilityFilters(req);

    const where: any = {
      status: "OPEN",
      ...jobWhereVisible, // keep your query-level visibility rules
    };

    if (q && q.trim()) {
      where.OR = [
        { title: { contains: q.trim(), mode: "insensitive" } },
        { description: { contains: q.trim(), mode: "insensitive" } },
      ];
    }

    if (location && location.trim()) {
      where.location = { contains: location.trim(), mode: "insensitive" };
    }

    const jobs = await prisma.job.findMany({
      where,
      orderBy: [{ id: "desc" }],
      take,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
      include: {
        consumer: { select: { id: true, name: true, location: true, isSuspended: true } },
        _count: { select: { bids: true } },
        attachments: true,
      },
    });

    // Optional favorites block (keep if you have favoriteJob)
    let favoriteJobIds = new Set<number>();
    if (jobs.length > 0) {
      const jobIds = jobs.map((j) => j.id);
      const favs = await prisma.favoriteJob.findMany({
        where: { userId: req.user.userId, jobId: { in: jobIds } },
        select: { jobId: true },
      });
      favoriteJobIds = new Set(favs.map((f) => f.jobId));
    }

    const nextCursor = jobs.length === take ? jobs[jobs.length - 1].id : null;

    return res.json({
      items: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        description: j.description,
        budgetMin: j.budgetMin,
        budgetMax: j.budgetMax,
        status: j.status,
        location: j.location,
        createdAt: j.createdAt,
        bidCount: j._count.bids,
        isFavorited: favoriteJobIds.has(j.id),
        consumer: {
          id: j.consumer.id,
          name: j.consumer.name,
          location: j.consumer.location,
        },
        attachments: j.attachments ?? [],
      })),
      pageInfo: {
        limit: take,
        nextCursor,
      },
    });
  } catch (err) {
    console.error("GET /jobs/browse error:", err);
    return res.status(500).json({ error: "Internal server error while browsing jobs." });
  }
});


// POST /jobs/:jobId/attachments
// Body: { url: string, type?: string }
app.post("/jobs/:jobId/attachments", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId" });
    }

    const { url, type } = req.body as { url?: string; type?: string };

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url is required" });
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        status: true,
        title: true,
        location: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Only consumer who created the job can add attachments
    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({
        error: "You may only add attachments to jobs you created.",
      });
    }

    const attach = await prisma.jobAttachment.create({
      data: {
        jobId,
        url: url.trim(),
        type: type?.trim() || null,
      },
    });

    // ✅ Webhook: attachment added
    await enqueueWebhookEvent({
      eventType: "job.attachment_added",
      payload: {
        attachmentId: attach.id,
        jobId: attach.jobId,
        addedByUserId: req.user.userId,
        url: attach.url,
        type: attach.type,
        createdAt: attach.createdAt,
        job: {
          title: job.title,
          status: job.status,
          location: job.location,
        },
      },
    });

    return res.json({
      message: "Attachment added.",
      attachment: attach,
    });
  } catch (err) {
    console.error("POST /jobs/:jobId/attachments error:", err);
    return res.status(500).json({
      error: "Internal server error while adding attachment.",
    });
  }
});

// --- Bids: place bid on a job (PROVIDER only) ---
// POST /jobs/:jobId/bids
// Body: { amount, message? }
app.post("/jobs/:jobId/bids", authMiddleware, bidLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can place bids" });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId parameter" });
    }

    const { amount, message } = req.body;

    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: "amount is required." });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number." });
    }

    // Bid.message is required in schema → always persist a string
    const messageText =
      typeof message === "string" && message.trim().length > 0 ? message.trim() : "";

    // Subscription check (your existing logic)
    const subscription = await prisma.subscription.findUnique({
      where: { userId: req.user.userId },
      select: { tier: true },
    });
    const tier = subscription?.tier || "FREE";

    if (tier === "FREE") {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const bidsLast30 = await prisma.bid.count({
        where: {
          providerId: req.user.userId,
          createdAt: { gte: thirtyDaysAgo },
        },
      });

      if (bidsLast30 >= 5) {
        return res.status(403).json({
          error:
            "You have reached your free tier limit of 5 bids per 30 days. Upgrade your subscription for unlimited bidding.",
          bidsUsed: bidsLast30,
          limit: 5,
          tier,
          remainingBids: 0,
        });
      }
    }

    // IMPORTANT: include consumerId so we can notify the correct user
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, status: true, consumerId: true },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    // Block check (existing behavior)
    const blocked = await isBlockedBetween(req.user.userId, job.consumerId);
    if (blocked) {
      return res.status(403).json({
        error: "You cannot place a bid on this job because one of you has blocked the other.",
      });
    }

    if (job.status !== "OPEN") {
      return res.status(400).json({
        error: `This job is not open for new bids. Current status: ${job.status}.`,
      });
    }

    const bid = await prisma.bid.create({
      data: {
        amount: numericAmount,
        message: messageText,
        jobId,
        providerId: req.user.userId,
      },
    });

    // 🔔 Notify the job owner (consumer)
    await createNotification({
      userId: job.consumerId,
      type: "NEW_BID",
      content: `New bid (#${bid.id}) on your job "${job.title}".`,
    });

    // ✅ Webhook: bid placed (after bid + notification succeed)
    await enqueueWebhookEvent({
      eventType: "bid.placed",
      payload: {
        bidId: bid.id,
        jobId: bid.jobId,
        providerId: bid.providerId,
        consumerId: job.consumerId,
        amount: bid.amount,
        message: bid.message,
        createdAt: bid.createdAt,
        jobTitle: job.title,
        jobStatus: job.status,
        providerTier: tier,
      },
    });

    return res.status(201).json({
      id: bid.id,
      amount: bid.amount,
      message: bid.message,
      jobId: bid.jobId,
      providerId: bid.providerId,
      createdAt: bid.createdAt,
    });
  } catch (err) {
    console.error("Place bid error:", err);
    return res.status(500).json({ error: "Internal server error while placing bid." });
  }
});

// GET /jobs/:jobId/bids → consumer sees all bids on their job
app.get(
  "/jobs/:jobId/bids",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) {
        return res.status(400).json({ error: "Invalid job id" });
      }

      // Ensure job exists and belongs to this consumer
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          title: true,
          status: true,
          consumerId: true,
          // ✅ Optional, if your schema has it and you want job-level visibility:
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      const isOwnerConsumer =
        req.user.role === "CONSUMER" && job.consumerId === req.user.userId;

      if (!isOwnerConsumer && !isAdmin(req)) {
        return res.status(403).json({
          error: "You can only view bids for jobs you created.",
        });
      }


      // ✅ (Optional but recommended) enforce job visibility even for owner? up to you.
      // Most apps let owners see their own hidden jobs, so we usually do NOT block here.
      // If you DO want to block owners from hidden jobs too (rare), uncomment:
      //
      // if (!isAdmin(req)) {
      //   if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      //   if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
      // }

      const { userWhereVisible } = visibilityFilters(req);

      // Fetch bids, filtering out suspended providers for non-admin
      const bids = await prisma.bid.findMany({
        where: {
          jobId,
          provider: {
            ...userWhereVisible, // ✅ hide suspended providers for non-admin
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          provider: {
            include: {
              providerProfile: true,
            },
          },
        },
      });

      // Is this job favorited by the current user?
      // (Owner is consumer, but leaving generic is fine)
      let jobIsFavorited = false;
      const fav = await prisma.favoriteJob.findUnique({
        where: {
          userId_jobId: {
            userId: req.user.userId,
            jobId,
          },
        },
      });
      jobIsFavorited = !!fav;

      return res.json(
        bids.map((b) => ({
          id: b.id,
          amount: b.amount,
          message: b.message,
          status: b.status,
          createdAt: b.createdAt,
          jobIsFavorited,
          provider: {
            id: b.provider.id,
            name: b.provider.name,
            location: b.provider.location,
            rating: b.provider.providerProfile?.rating ?? null,
            reviewCount: b.provider.providerProfile?.reviewCount ?? 0,
          },
        }))
      );
    } catch (err) {
      console.error("GET /jobs/:jobId/bids error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching bids.",
      });
    }
  }
);

// --- Consumer: My Jobs (with bid counts) ---
// GET /consumer/jobs
app.get("/consumer/jobs", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can view their jobs." });
    }

    const jobs = await prisma.job.findMany({
      where: { consumerId: req.user.userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { bids: true },
        },
      },
    });

    return res.json(
      jobs.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.status,
        location: job.location,
        createdAt: job.createdAt,
        bidCount: job._count.bids,
      }))
    );
  } catch (err) {
    console.error("Consumer My Jobs error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching consumer jobs." });
  }
});


// --- Consumer: Job Details (for a single job the consumer owns) ---
// GET /consumer/jobs/:jobId
app.get("/consumer/jobs/:jobId", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can view this resource." });
    }

    const jobIdParam = req.params.jobId;
    const jobId = Number(jobIdParam);

    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId parameter" });
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        _count: {
          select: { bids: true },
        },
        attachments: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // Ensure this job belongs to the current consumer
    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({
        error: "You do not have permission to view this job.",
      });
    }

    return res.json({
      id: job.id,
      title: job.title,
      description: job.description,
      budgetMin: job.budgetMin,
      budgetMax: job.budgetMax,
      location: job.location,
      status: job.status,
      createdAt: job.createdAt,
      bidCount: job._count.bids,
      attachments: job.attachments.map((a) => ({
        id: a.id,
        url: a.url,
        type: a.type,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error("Consumer Job Details error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching job details." });
  }
});

// --- Provider: My Bids ---
// GET /provider/bids
app.get("/provider/bids", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can view their bids." });
    }

    const bids = await prisma.bid.findMany({
      where: { providerId: req.user.userId },
      orderBy: { createdAt: "desc" },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            location: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    return res.json(
      bids.map((b) => ({
        id: b.id,
        amount: b.amount,
        message: b.message,
        status: b.status,
        createdAt: b.createdAt,
        job: {
          id: b.job.id,
          title: b.job.title,
          location: b.job.location,
          status: b.job.status,
          createdAt: b.job.createdAt
        },
      }))
    );
  } catch (err) {
    console.error("Provider My Bids error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching provider bids." });
  }
});

// --- Provider: Job Details (optionally with this provider's bid) ---
// GET /provider/jobs/:jobId
app.get(
  "/provider/jobs/:jobId",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can view this resource." });
      }

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) {
        return res.status(400).json({ error: "Invalid jobId parameter" });
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          title: true,
          description: true,
          budgetMin: true,
          budgetMax: true,
          location: true,
          status: true,
          createdAt: true,
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      // Fetch this provider's bid on the job, if any
      const myBid = await prisma.bid.findFirst({
        where: {
          jobId: job.id,
          providerId: req.user.userId,
        },
        select: {
          id: true,
          amount: true,
          message: true,
          createdAt: true,
          status: true, // ✅ key fix: include status so ACCEPTED is visible
        },
      });

      return res.json({
        job,
        myBid: myBid ?? null,
      });
    } catch (err) {
      console.error("Provider Job Details error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching job details." });
    }
  }
);


// POST /jobs/:jobId/reviews  → consumer leaves or updates a review for the provider on this job
app.post("/jobs/:jobId/reviews", async (req, res) => {
  try {
    const user = getUserFromAuthHeader(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Only consumers can leave reviews
    if (user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can leave reviews on jobs." });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId in URL." });
    }

    const { rating, comment } = req.body as { rating?: number; comment?: string };

    const ratingNum = Number(rating);
    if (!ratingNum || Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: "rating must be a number between 1 and 5." });
    }

    // Fetch job (to verify ownership & status)
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, consumerId: true, status: true, title: true },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // Ensure this user owns the job
    if (job.consumerId !== user.userId) {
      return res.status(403).json({ error: "You can only review jobs that you created." });
    }

    // Only allow review if job has been COMPLETED
    if (job.status !== "COMPLETED") {
      return res.status(400).json({
        error: `Only COMPLETED jobs can be reviewed. Current status: ${job.status}.`,
      });
    }

    // Find the accepted bid on this job to get the providerId
    const acceptedBid = await prisma.bid.findFirst({
      where: { jobId, status: "ACCEPTED" },
      select: { id: true, providerId: true },
    });

    if (!acceptedBid) {
      return res.status(400).json({
        error: "No accepted bid found for this job. Cannot determine which provider to review.",
      });
    }

    const providerId = acceptedBid.providerId;

    // Check if this consumer already reviewed this job+provider → update instead of create
    const existing = await prisma.review.findFirst({
      where: { jobId, consumerId: user.userId, providerId },
    });

    const commentValue = comment?.trim() || null;

    let review;
    let eventType: "review.created" | "review.updated" = "review.created";

    if (existing) {
      eventType = "review.updated";
      review = await prisma.review.update({
        where: { id: existing.id },
        data: { rating: ratingNum, comment: commentValue },
      });
    } else {
      review = await prisma.review.create({
        data: {
          jobId,
          consumerId: user.userId,
          providerId,
          rating: ratingNum,
          comment: commentValue,
        },
      });
    }

    // Recompute provider's average rating & reviewCount
    const stats = await prisma.review.aggregate({
      where: { providerId },
      _avg: { rating: true },
      _count: { _all: true },
    });

    const ratingSummary = {
      averageRating: stats._avg.rating ?? null,
      reviewCount: stats._count._all ?? 0,
    };

    // Update ProviderProfile.rating & reviewCount (use upsert to be safe)
    await prisma.providerProfile.upsert({
      where: { providerId },
      update: {
        rating: ratingSummary.averageRating,
        reviewCount: ratingSummary.reviewCount,
      },
      create: {
        providerId,
        rating: ratingSummary.averageRating,
        reviewCount: ratingSummary.reviewCount,
      },
    });

    // ✅ Webhook: review created/updated (after review + provider profile update)
    await enqueueWebhookEvent({
      eventType,
      payload: {
        reviewId: review.id,
        jobId,
        jobTitle: job.title,
        consumerId: user.userId,
        providerId,
        acceptedBidId: acceptedBid.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
        ratingSummary,
      },
    });

    return res.status(existing ? 200 : 201).json({
      message: existing ? "Review updated." : "Review created.",
      review,
      ratingSummary,
    });
  } catch (err) {
    console.error("Create/update review error:", err);
    return res.status(500).json({
      error: "Internal server error while creating/updating review.",
    });
  }
});

// GET /providers/:providerId/reviews → list all reviews for a provider
app.get(
  "/providers/:providerId/reviews",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const providerId = Number(req.params.providerId);
      if (Number.isNaN(providerId)) {
        return res
          .status(400)
          .json({ error: "Invalid providerId parameter." });
      }

      // Ensure provider exists and is actually a PROVIDER
      const provider = await prisma.user.findUnique({
        where: { id: providerId },
        include: {
          providerProfile: true,
        },
      });

      if (!provider || provider.role !== "PROVIDER") {
        return res.status(404).json({ error: "Provider not found." });
      }

      // Fetch reviews with job + consumer info
      const reviews = await prisma.review.findMany({
        where: { providerId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          job: {
            select: {
              id: true,
              title: true,
            },
          },
          consumer: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // If providerProfile exists, use its rating & count; otherwise compute on the fly
      let averageRating = provider.providerProfile?.rating ?? null;
      let reviewCount = provider.providerProfile?.reviewCount ?? null;

      if (averageRating === null || reviewCount === null) {
        const agg = await prisma.review.aggregate({
          where: { providerId },
          _avg: { rating: true },
          _count: { _all: true },
        });

        averageRating = agg._avg.rating ?? null;
        reviewCount = agg._count._all ?? 0;

        // Optionally sync ProviderProfile for future use
        await prisma.providerProfile.upsert({
          where: { providerId },
          update: {
            rating: averageRating,
            reviewCount: reviewCount,
          },
          create: {
            providerId,
            rating: averageRating,
            reviewCount: reviewCount,
          },
        });
      }

      return res.json({
        provider: {
          id: provider.id,
          name: provider.name,
          email: provider.email,
        },
        ratingSummary: {
          averageRating,
          reviewCount,
        },
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt,
          job: {
            id: r.job.id,
            title: r.job.title,
          },
          consumer: {
            id: r.consumer.id,
            name: r.consumer.name,
          },
        })),
      });
    } catch (err) {
      console.error("GET /providers/:providerId/reviews error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching provider reviews.",
      });
    }
  }
);

// GET /me/inbox → list "threads" across all jobs for current user
// Returns: job summary + lastMessage + unreadCount + lastReadAt
app.get("/me/inbox", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    // Role-based scoping: which jobs count as "my threads"
    // - CONSUMER: jobs I own
    // - PROVIDER: jobs I've bid on
    // - ADMIN: all jobs (but only those with messages, for sanity)
    let roleWhere: any = {};
    if (!isAdmin(req)) {
      if (req.user.role === "CONSUMER") {
        roleWhere = { consumerId: req.user.userId };
      } else if (req.user.role === "PROVIDER") {
        roleWhere = { bids: { some: { providerId: req.user.userId } } };
      } else {
        // Non-admin non-consumer/provider should not happen, but keep it safe:
        return res.status(403).json({ error: "Unsupported role for inbox." });
      }
    }

    // Only include jobs that actually have at least one visible message for this user.
    // (Otherwise “threads” would be empty/noisy.)
    const jobs = await prisma.job.findMany({
      where: {
        ...jobWhereVisible,
        ...roleWhere,
        messages: {
          some: {
            ...messageWhereVisible,
          },
        },
      },
      select: {
        id: true,
        title: true,
        location: true,
        status: true,
        createdAt: true,
        // Fetch the latest visible message as "lastMessage"
        messages: {
          where: { ...messageWhereVisible },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            text: true,
            senderId: true,
            createdAt: true,
            isHidden: true, // admin can see hidden; for non-admin this should always be false due to messageWhereVisible
          },
        },
      },
      // lightweight ordering: newest threads first (based on latest visible message timestamp)
      // NOTE: Prisma can't orderBy relation aggregate cleanly in all versions, so we sort in memory after.
      skip,
      take: pageSize,
    });

    // Pull read states in one query
    const jobIds = jobs.map((j) => j.id);
    const states = await prisma.jobMessageReadState.findMany({
      where: { userId: req.user.userId, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });
    const lastReadAtByJobId = new Map<number, Date>(
      states.map((s) => [s.jobId, s.lastReadAt])
    );

    // Compute unread counts (lightweight N jobs → N counts; OK for <= 50 threads)
    const threads = await Promise.all(
      jobs.map(async (job) => {
        const lastMessage = job.messages[0] ?? null;
        const lastReadAt = lastReadAtByJobId.get(job.id) ?? new Date(0);

        const unreadCount = await prisma.message.count({
          where: {
            jobId: job.id,
            ...messageWhereVisible,
            createdAt: { gt: lastReadAt },
            senderId: { not: req.user!.userId },
          },
        });

        return {
          job: {
            id: job.id,
            title: job.title,
            location: job.location,
            status: job.status,
            createdAt: job.createdAt,
          },
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                text: lastMessage.text,
                senderId: lastMessage.senderId,
                createdAt: lastMessage.createdAt,
                isHidden: lastMessage.isHidden,
              }
            : null,
          unreadCount,
          lastReadAt,
        };
      })
    );

    // Sort in memory by lastMessage.createdAt desc (stable UX even if DB ordering differs)
    threads.sort((a, b) => {
      const at = a.lastMessage?.createdAt?.getTime?.() ?? 0;
      const bt = b.lastMessage?.createdAt?.getTime?.() ?? 0;
      return bt - at;
    });

    return res.json({
      page,
      pageSize,
      threads,
    });
  } catch (err) {
    console.error("GET /me/inbox error:", err);
    return res.status(500).json({ error: "Internal server error while fetching inbox." });
  }
});

// GET /me/inbox/unread-total → total unread messages across all job threads for current user
app.get("/me/inbox/unread-total", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    // 1) Determine the set of jobIds that are "threads" for this user
    // - CONSUMER: jobs I own
    // - PROVIDER: jobs I've bid on
    // - ADMIN: all jobs (but we'll still only count messages visible to admin)
    let roleWhere: any = {};
    if (!isAdmin(req)) {
      if (req.user.role === "CONSUMER") {
        roleWhere = { consumerId: req.user.userId };
      } else if (req.user.role === "PROVIDER") {
        roleWhere = { bids: { some: { providerId: req.user.userId } } };
      } else {
        return res.status(403).json({ error: "Unsupported role for inbox." });
      }
    }

    const jobs = await prisma.job.findMany({
      where: {
        ...jobWhereVisible,
        ...roleWhere,
        // only jobs that have at least one visible message (so we count "threads" that exist)
        messages: { some: { ...messageWhereVisible } },
      },
      select: { id: true },
    });

    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length === 0) {
      return res.json({ totalUnread: 0 });
    }

    // 2) Load read states for these jobs
    const states = await prisma.jobMessageReadState.findMany({
      where: { userId: req.user.userId, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });

    const lastReadAtByJobId = new Map<number, Date>(
      states.map((s) => [s.jobId, s.lastReadAt])
    );

    // 3) Optimization: fetch messages newer than the *minimum* lastReadAt among threads
    // (then filter precisely in memory per job)
    let minLastReadAt = new Date(0);
    if (states.length > 0) {
      minLastReadAt = states.reduce(
        (min, s) => (s.lastReadAt < min ? s.lastReadAt : min),
        states[0].lastReadAt
      );
    }

    const candidateMessages = await prisma.message.findMany({
      where: {
        jobId: { in: jobIds },
        ...messageWhereVisible,
        senderId: { not: req.user.userId },
        createdAt: { gt: minLastReadAt },
      },
      select: {
        jobId: true,
        createdAt: true,
      },
    });

    // 4) Exact count: message is unread if createdAt > lastReadAt for that job
    let totalUnread = 0;
    for (const m of candidateMessages) {
      const lastReadAt = lastReadAtByJobId.get(m.jobId) ?? new Date(0);
      if (m.createdAt > lastReadAt) totalUnread += 1;
    }

    return res.json({ totalUnread });
  } catch (err) {
    console.error("GET /me/inbox/unread-total error:", err);
    return res.status(500).json({ error: "Internal server error while fetching unread total." });
  }
});

// GET /me/inbox/threads
// Returns: per-job "thread" objects with lastMessage + unreadCount, newest first.
// Query params:
//   - limit (default 20, max 50)
//   - cursor (optional): base64 JSON { createdAt: string, id: number }
// Cursor is based on the lastMessage (createdAt + id) from the previous page.
app.get("/me/inbox/threads", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

    // Cursor parsing: base64(JSON.stringify({ createdAt, id }))
    let cursor: { createdAt: Date; id: number } | null = null;
    if (typeof req.query.cursor === "string" && req.query.cursor.trim() !== "") {
      try {
        const decoded = Buffer.from(req.query.cursor, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as { createdAt: string; id: number };
        const d = new Date(parsed.createdAt);
        if (!Number.isNaN(d.getTime()) && typeof parsed.id === "number") {
          cursor = { createdAt: d, id: parsed.id };
        }
      } catch {
        return res.status(400).json({ error: "Invalid cursor." });
      }
    }

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    const me = req.user.userId;

    // Jobs the user is allowed to have "threads" for:
    // - Admin: can see all jobs (subject to visibility filters; for admins these usually allow all)
    // - Consumer: jobs they own
    // - Provider: jobs where they've bid
    const participantJobWhere = isAdmin(req)
      ? { ...jobWhereVisible }
      : {
          ...jobWhereVisible,
          OR: [
            { consumerId: me },
            { bids: { some: { providerId: me } } },
          ],
        };

    // Cursor filter for "newest first" paging, based on lastMessage.createdAt then lastMessage.id.
    // We apply it to the message query so we're paging by the "latest message per job".
    const cursorMessageWhere =
      cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          };

    // 1) Grab the latest visible message PER JOB using `distinct: ["jobId"]`
    // Ordered by createdAt desc (and id desc for stability), then distinct keeps first per job.
    const latestMessages = await prisma.message.findMany({
      where: {
        ...messageWhereVisible,
        ...cursorMessageWhere,
        job: participantJobWhere,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["jobId"],
      take: limit,
      select: {
        id: true,
        jobId: true,
        senderId: true,
        text: true,
        createdAt: true,
        sender: { select: { id: true, name: true, email: true, role: true } },
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            location: true,
            consumerId: true,
          },
        },
      },
    });

    // If no threads, done.
    if (latestMessages.length === 0) {
      return res.json({ threads: [], nextCursor: null });
    }

    const jobIds = latestMessages.map((m) => m.jobId);

    // 2) Load read states for these jobs
    const readStates = await prisma.jobMessageReadState.findMany({
      where: { userId: me, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });

    const lastReadMap = new Map<number, Date>();
    for (const rs of readStates) lastReadMap.set(rs.jobId, rs.lastReadAt);

    // If a state doesn't exist yet, treat as "never read"
    const epoch = new Date(0);

    // 3) Efficient unread counting:
    // Find the earliest lastReadAt among these threads, fetch only messages after that,
    // then count per-job where message.createdAt > lastReadAt and senderId != me.
    let minLastReadAt = epoch;
    for (const jobId of jobIds) {
      const lr = lastReadMap.get(jobId) ?? epoch;
      if (minLastReadAt.getTime() === 0 || lr < minLastReadAt) minLastReadAt = lr;
    }

    const candidateUnread = await prisma.message.findMany({
      where: {
        jobId: { in: jobIds },
        ...messageWhereVisible,
        createdAt: { gt: minLastReadAt },
        senderId: { not: me }, // don't count your own messages as unread
      },
      select: { jobId: true, createdAt: true },
    });

    const unreadCountMap = new Map<number, number>();
    for (const msg of candidateUnread) {
      const lastReadAt = lastReadMap.get(msg.jobId) ?? epoch;
      if (msg.createdAt > lastReadAt) {
        unreadCountMap.set(msg.jobId, (unreadCountMap.get(msg.jobId) ?? 0) + 1);
      }
    }

    // 4) Build response
    const threads = latestMessages.map((m) => ({
      job: m.job,
      lastMessage: {
        id: m.id,
        jobId: m.jobId,
        senderId: m.senderId,
        sender: m.sender,
        text: m.text,
        createdAt: m.createdAt,
      },
      unreadCount: unreadCountMap.get(m.jobId) ?? 0,
    }));

    // Next cursor = the last item in this page (oldest among returned latestMessages)
    const last = latestMessages[latestMessages.length - 1];
    const nextCursor = Buffer.from(
      JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
      "utf8"
    ).toString("base64");

    return res.json({ threads, nextCursor });
  } catch (err) {
    console.error("GET /me/inbox/threads error:", err);
    return res.status(500).json({ error: "Internal server error while fetching inbox threads." });
  }
});


// GET /me/reviews → if I'm a provider, see my own reviews + summary
app.get("/me/reviews", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers have reviews to view here." });
    }

    const providerId = req.user.userId;

    const reviews = await prisma.review.findMany({
      where: { providerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        job: {
          select: {
            id: true,
            title: true,
            location: true,
          },
        },
        // ✅ FIX: "consumer" is the reviewer in your schema (not "reviewer")
        consumer: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const agg = await prisma.review.aggregate({
      where: { providerId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    return res.json({
      providerId,
      summary: {
        averageRating: agg._avg.rating ?? null,
        reviewCount: agg._count.rating,
      },
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        job: r.job
          ? {
              id: r.job.id,
              title: r.job.title,
              location: r.job.location,
            }
          : null,
        // ✅ FIX: return consumer as the reviewer
        consumer: {
          id: r.consumer.id,
          name: r.consumer.name,
        },
      })),
    });
  } catch (err) {
    console.error("GET /me/reviews error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching my reviews." });
  }
});


// GET /providers/top?limit=10
app.get(
  "/providers/top",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 10, 50);

      const { userWhereVisible } = visibilityFilters(req);

      const profiles = await prisma.providerProfile.findMany({
        where: {
          provider: {
            role: "PROVIDER",
            ...userWhereVisible, // ✅ hide suspended providers for non-admin
          },
        },
        orderBy: [{ rating: "desc" }, { reviewCount: "desc" }],
        take: limit,
        select: {
          experience: true,
          specialties: true,
          rating: true,
          reviewCount: true,
          categories: { select: { id: true, name: true, slug: true } },
          provider: { select: { id: true, name: true, email: true, phone: true, location: true } },
        }
      });

      // Favorites (provider favorites) for consumer
      let favoriteIds = new Set<number>();
      if (req.user?.role === "CONSUMER" && profiles.length > 0) {
        const providerIds = profiles.map((p) => p.provider.id);
        const favorites = await prisma.favoriteProvider.findMany({
          where: {
            consumerId: req.user.userId,
            providerId: { in: providerIds },
          },
        });
        favoriteIds = new Set(favorites.map((f) => f.providerId));
      }

      return res.json(
        profiles.map((p) => ({
          id: p.provider.id,
          name: p.provider.name,
          email: p.provider.email,
          phone: p.provider.phone,
          location: p.provider.location,
          experience: p.experience,
          specialties: p.specialties,
          rating: p.rating,
          reviewCount: p.reviewCount,
          isFavorited:
            req.user?.role === "CONSUMER" ? favoriteIds.has(p.provider.id) : false,
          categories: p.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })),
        }))
      );
    } catch (err) {
      console.error("GET /providers/top error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching top providers." });
    }
  }
);


// GET /providers/search
// Query params:
//   q?: string
//   location?: string
//   specialty?: string
//   minRating?: number
//   minReviews?: number
//   page?: number (1-based, default 1)
//   pageSize?: number (default 10, max 50)
app.get(
  "/providers/search",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const {
        q,
        location,
        specialty,
        minRating,
        minReviews,
        page = "1",
        pageSize = "10",
      } = req.query as {
        q?: string;
        location?: string;
        specialty?: string;
        minRating?: string;
        minReviews?: string;
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(Number(page) || 1, 1);
      const take = Math.min(Number(pageSize) || 10, 50);
      const skip = (pageNum - 1) * take;

      const { userWhereVisible } = visibilityFilters(req);

      // Build where clause for ProviderProfile + related provider
      const where: any = {
        provider: {
          role: "PROVIDER",
          ...userWhereVisible, // ✅ hide suspended providers for non-admin
        },
      };

      if (q && q.trim()) {
        where.provider.name = { contains: q.trim(), mode: "insensitive" };
      }

      if (location && location.trim()) {
        where.provider.location = { contains: location.trim(), mode: "insensitive" };
      }

      if (specialty && specialty.trim()) {
        where.specialties = { contains: specialty.trim(), mode: "insensitive" };
      }

      const minRatingNum = Number(minRating);
      if (!Number.isNaN(minRatingNum) && minRatingNum > 0) {
        where.rating = { gte: minRatingNum };
      }

      const minReviewsNum = Number(minReviews);
      if (!Number.isNaN(minReviewsNum) && minReviewsNum > 0) {
        where.reviewCount = { gte: minReviewsNum };
      }

      const [profiles, total] = await Promise.all([
        prisma.providerProfile.findMany({
          where,
            select: {
              experience: true,
              specialties: true,
              rating: true,
              reviewCount: true,
              categories: { select: { id: true, name: true, slug: true } },
              provider: { select: { id: true, name: true, email: true, phone: true, location: true } },
            },
          orderBy: [{ rating: "desc" }, { reviewCount: "desc" }, { provider: { name: "asc" } }],
          skip,
          take,
        }),
        prisma.providerProfile.count({ where }),
      ]);

      // Favorites for consumer
      let favoriteIds = new Set<number>();
      if (req.user?.role === "CONSUMER" && profiles.length > 0) {
        const providerIds = profiles.map((p) => p.provider.id);
        const favorites = await prisma.favoriteProvider.findMany({
          where: {
            consumerId: req.user.userId,
            providerId: { in: providerIds },
          },
        });
        favoriteIds = new Set(favorites.map((f) => f.providerId));
      }

      return res.json({
        page: pageNum,
        pageSize: take,
        total,
        totalPages: Math.ceil(total / take) || 1,
        providers: profiles.map((p) => ({
          id: p.provider.id,
          name: p.provider.name,
          email: p.provider.email,
          phone: p.provider.phone,
          location: p.provider.location,
          experience: p.experience,
          specialties: p.specialties,
          rating: p.rating,
          reviewCount: p.reviewCount,
          isFavorited:
            req.user?.role === "CONSUMER" ? favoriteIds.has(p.provider.id) : false,
          categories: p.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })),
        })),
      });
    } catch (err) {
      console.error("GET /providers/search error:", err);
      return res.status(500).json({
        error: "Internal server error while searching providers.",
      });
    }
  }
);

// GET /providers/search/feed
// Cursor-based provider feed (stable ordering by providerId)
// Query params:
//   cursor?: number (providerId)
//   limit?: number (default 20, max 50)
app.get("/providers/search/feed", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = parsePositiveInt(limit, 20, 50);
    const cursorId = parseOptionalCursorId(cursor);

    const { userWhereVisible } = visibilityFilters(req);

    const where: any = {
      provider: {
        role: "PROVIDER",
        ...userWhereVisible,
      },
    };

    const profiles = await prisma.providerProfile.findMany({
      where,
      orderBy: [{ providerId: "desc" }],
      take,
      ...(cursorId ? { cursor: { providerId: cursorId }, skip: 1 } : {}),
      select: {
        experience: true,
        specialties: true,
        rating: true,
        reviewCount: true,
        categories: { select: { id: true, name: true, slug: true } },
        provider: { select: { id: true, name: true, email: true, phone: true, location: true } },
      },
    });

    let favoriteIds = new Set<number>();
    if (req.user.role === "CONSUMER" && profiles.length > 0) {
      const providerIds = profiles.map((p) => p.provider.id);
      const favorites = await prisma.favoriteProvider.findMany({
        where: { consumerId: req.user.userId, providerId: { in: providerIds } },
        select: { providerId: true },
      });
      favoriteIds = new Set(favorites.map((f) => f.providerId));
    }

    const nextCursor = profiles.length === take ? profiles[profiles.length - 1].provider.id : null;

    return res.json({
      items: profiles.map((p) => ({
        id: p.provider.id,
        name: p.provider.name,
        email: p.provider.email,
        phone: p.provider.phone,
        location: p.provider.location,
        experience: p.experience,
        specialties: p.specialties,
        rating: p.rating,
        reviewCount: p.reviewCount,
        isFavorited: req.user.role === "CONSUMER" ? favoriteIds.has(p.provider.id) : false,
        categories: p.categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      })),
      pageInfo: { limit: take, nextCursor },
    });
  } catch (err) {
    console.error("GET /providers/search/feed error:", err);
    return res.status(500).json({ error: "Internal server error while fetching provider feed." });
  }
});


// GET /providers/me → current provider's profile
app.get(
  "/providers/me",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (req.user.role !== "PROVIDER") {
        return res
          .status(403)
          .json({ error: "Only providers have a provider profile." });
      }

      const provider = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: {
          providerProfile: {
            include: {
              categories: true,
            },
          },
        },
      });

      if (!provider) {
        return res.status(404).json({ error: "Provider not found." });
      }

      return res.json({
        id: provider.id,
        name: provider.name,
        email: provider.email,
        phone: provider.phone,
        location: provider.location,
        createdAt: provider.createdAt,
        experience: provider.providerProfile?.experience ?? null,
        specialties: provider.providerProfile?.specialties ?? null,
        rating: provider.providerProfile?.rating ?? null,
        reviewCount: provider.providerProfile?.reviewCount ?? 0,
        categories:
          provider.providerProfile?.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })) ?? [],
      });
    } catch (err) {
      console.error("GET /providers/me error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching profile." });
    }
  }
);

// PUT /providers/me/profile
// Body: { experience?: string, specialties?: string, location?: string }
app.put("/providers/me/profile", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can update a provider profile." });
    }

    const { experience, specialties, location } = req.body as {
      experience?: string;
      specialties?: string;
      location?: string;
    };

    // Update User (location) if provided
    const userUpdateData: any = {};
    if (typeof location === "string") {
      userUpdateData.location = location.trim() || null;
    }

    const [updatedUser, updatedProfile] = await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.userId },
        data: userUpdateData,
      }),
      prisma.providerProfile.upsert({
        where: { providerId: req.user.userId },
        update: {
          experience: typeof experience === "string" ? experience.trim() || null : undefined,
          specialties: typeof specialties === "string" ? specialties.trim() || null : undefined,
        },
        create: {
          providerId: req.user.userId,
          experience: typeof experience === "string" ? experience.trim() || null : null,
          specialties: typeof specialties === "string" ? specialties.trim() || null : null,
        },
      }),
    ]);

    // ✅ Webhook: provider profile updated
    await enqueueWebhookEvent({
      eventType: "provider.profile_updated",
      payload: {
        providerId: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email, // remove if you want less PII
        phone: updatedUser.phone ?? null,
        location: updatedUser.location ?? null,
        experience: updatedProfile.experience ?? null,
        specialties: updatedProfile.specialties ?? null,
        rating: updatedProfile.rating ?? null,
        reviewCount: updatedProfile.reviewCount ?? 0,
        updatedAt: new Date(),
      },
    });

    return res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      location: updatedUser.location,
      experience: updatedProfile.experience,
      specialties: updatedProfile.specialties,
      rating: updatedProfile.rating,
      reviewCount: updatedProfile.reviewCount,
    });
  } catch (err) {
    console.error("PUT /providers/me/profile error:", err);
    return res.status(500).json({
      error: "Internal server error while updating provider profile.",
    });
  }
});

// PUT /providers/me/categories
// Body: { categoryIds: number[] }
app.put("/providers/me/categories", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can set categories." });
    }

    const { categoryIds } = req.body as { categoryIds?: number[] };

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({
        error: "categoryIds must be a non-empty array of numeric IDs.",
      });
    }

    const uniqueIds = Array.from(new Set(categoryIds)).filter(
      (id) => typeof id === "number" && !Number.isNaN(id)
    );

    if (uniqueIds.length === 0) {
      return res.status(400).json({
        error: "categoryIds must contain at least one valid numeric id.",
      });
    }

    // Ensure providerProfile exists
    const profile = await prisma.providerProfile.upsert({
      where: { providerId: req.user.userId },
      update: {},
      create: {
        providerId: req.user.userId,
      },
    });

    // Replace categories (clear and connect)
    const updatedProfile = await prisma.providerProfile.update({
      where: { id: profile.id },
      data: {
        categories: {
          set: [], // clear old
          connect: uniqueIds.map((id) => ({ id })),
        },
      },
      include: {
        categories: true,
      },
    });

    // ✅ Webhook: provider categories updated
    await enqueueWebhookEvent({
      eventType: "provider.categories_updated",
      payload: {
        providerId: updatedProfile.providerId,
        categoryIds: updatedProfile.categories.map((c) => c.id),
        categories: updatedProfile.categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
        updatedAt: new Date(),
      },
    });

    return res.json({
      id: updatedProfile.id,
      providerId: updatedProfile.providerId,
      categories: updatedProfile.categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
      })),
    });
  } catch (err) {
    console.error("PUT /providers/me/categories error:", err);
    return res.status(500).json({
      error: "Internal server error while updating provider categories. Ensure categoryIds are valid.",
    });
  }
});

// GET /categories/with-providers?limitPerCategory=3
// Returns categories with providerCount and top providers per category
app.get(
  "/categories/with-providers",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const limitPerCategory = Math.min(
        Number(req.query.limitPerCategory) || 3,
        10
      );

      const categories = await prisma.category.findMany({
        orderBy: { name: "asc" },
        include: {
          providerProfiles: {
            include: {
              provider: true,
            },
          },
        },
      });

      const result = categories.map((cat) => {
        const profiles = cat.providerProfiles;

        // Sort profiles by rating desc, then reviewCount desc
        const sorted = [...profiles].sort((a, b) => {
          const ratingA = a.rating ?? 0;
          const ratingB = b.rating ?? 0;
          if (ratingA !== ratingB) {
            return ratingB - ratingA;
          }
          const reviewsA = a.reviewCount ?? 0;
          const reviewsB = b.reviewCount ?? 0;
          return reviewsB - reviewsA;
        });

        const topProfiles = sorted.slice(0, limitPerCategory);

        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          providerCount: profiles.length,
          topProviders: topProfiles.map((p) => ({
            id: p.provider.id,
            name: p.provider.name,
            email: p.provider.email,
            phone: p.provider.phone,
            location: p.provider.location,
            experience: p.experience,
            specialties: p.specialties,
            rating: p.rating,
            reviewCount: p.reviewCount ?? 0,
          })),
        };
      });

      return res.json(result);
    } catch (err) {
      console.error("GET /categories/with-providers error:", err);
      return res.status(500).json({
        error:
          "Internal server error while fetching categories with providers.",
      });
    }
  }
);


// POST /providers/:id/favorite → consumer favorites a provider
app.post("/providers/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can favorite providers." });
    }

    const providerId = Number(req.params.id);
    if (Number.isNaN(providerId)) {
      return res.status(400).json({ error: "Invalid provider id" });
    }

    const provider = await prisma.user.findUnique({
      where: { id: providerId },
      select: { id: true, role: true, isSuspended: true },
    });

    if (!provider || provider.role !== "PROVIDER") {
      return res.status(404).json({ error: "Provider not found" });
    }

    // ✅ Visibility: suspended providers are invisible to non-admins
    if (!isAdmin(req) && provider.isSuspended) {
      return res.status(404).json({ error: "Provider not found" });
    }

    const fav = await prisma.favoriteProvider.upsert({
      where: {
        consumerId_providerId: {
          consumerId: req.user.userId,
          providerId,
        },
      },
      update: {},
      create: {
        consumerId: req.user.userId,
        providerId,
      },
      select: {
        consumerId: true,
        providerId: true,
        createdAt: true,
      },
    });

    // ✅ Webhook: provider favorited
    await enqueueWebhookEvent({
      eventType: "provider.favorited",
      payload: {
        consumerId: fav.consumerId,
        providerId: fav.providerId,
        createdAt: fav.createdAt,
      },
    });

    return res.status(201).json({ message: "Provider favorited." });
  } catch (err) {
    console.error("POST /providers/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while favoriting provider.",
    });
  }
});

// DELETE /providers/:id/favorite → consumer removes favorite
app.delete("/providers/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can unfavorite providers." });
    }

    const providerId = Number(req.params.id);
    if (Number.isNaN(providerId)) {
      return res.status(400).json({ error: "Invalid provider id" });
    }

    const result = await prisma.favoriteProvider.deleteMany({
      where: {
        consumerId: req.user.userId,
        providerId,
      },
    });

    // ✅ Webhook: provider unfavorited (only if deletion happened)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "provider.unfavorited",
        payload: {
          consumerId: req.user.userId,
          providerId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "Provider unfavorited." });
  } catch (err) {
    console.error("DELETE /providers/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while unfavoriting provider.",
    });
  }
});

// GET /me/favorites/providers → list providers this consumer has favorited
app.get(
  "/me/favorites/providers",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers have favorite providers." });
      }

      const favorites = await prisma.favoriteProvider.findMany({
        where: {
          consumerId: req.user.userId,
          ...(isAdmin(req)
            ? {}
            : {
                // ✅ hide suspended providers for non-admins
                provider: { isSuspended: false },
              }),
        },
        orderBy: { createdAt: "desc" },
        include: {
          provider: {
            include: {
              providerProfile: { include: { categories: true } },
            },
          },
        },
      });

      return res.json(
        favorites.map((fav) => ({
          favoritedAt: fav.createdAt,
          provider: {
            id: fav.provider.id,
            name: fav.provider.name,
            email: fav.provider.email,
            phone: fav.provider.phone,
            location: fav.provider.location,
            experience: fav.provider.providerProfile?.experience ?? null,
            specialties: fav.provider.providerProfile?.specialties ?? null,
            rating: fav.provider.providerProfile?.rating ?? null,
            reviewCount: fav.provider.providerProfile?.reviewCount ?? 0,
            isFavorited: true,
            categories:
              fav.provider.providerProfile?.categories.map((c) => ({
                id: c.id,
                name: c.name,
                slug: c.slug,
              })) ?? [],
          },
        }))
      );
    } catch (err) {
      console.error("GET /me/favorites/providers error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching favorite providers.",
      });
    }
  }
);

// GET /me/favorites/jobs → list jobs this user has favorited
app.get(
  "/me/favorites/jobs",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const favorites = await prisma.favoriteJob.findMany({
        where: {
          userId: req.user.userId,
          ...(isAdmin(req)
            ? {}
            : {
                // ✅ enforce job visibility rules for non-admins
                job: {
                  isHidden: false,
                  consumer: { isSuspended: false },
                },
              }),
        },
        orderBy: { createdAt: "desc" },
        include: {
          job: {
            include: {
              consumer: {
                select: { id: true, name: true, location: true },
              },
            },
          },
        },
      });

      return res.json(
        favorites.map((fav) => ({
          favoritedAt: fav.createdAt,
          job: {
            id: fav.job.id,
            title: fav.job.title,
            description: fav.job.description,
            budgetMin: fav.job.budgetMin,
            budgetMax: fav.job.budgetMax,
            status: fav.job.status,
            location: fav.job.location,
            createdAt: fav.job.createdAt,
            isFavorited: true,
            consumer: {
              id: fav.job.consumer.id,
              name: fav.job.consumer.name,
              location: fav.job.consumer.location,
            },
          },
        }))
      );
    } catch (err) {
      console.error("GET /me/favorites/jobs error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching favorite jobs.",
      });
    }
  }
);


// GET /providers/:id → public provider profile
app.get(
  "/providers/:id",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (Number.isNaN(providerId)) {
        return res.status(400).json({ error: "Invalid provider id" });
      }

      const provider = await prisma.user.findUnique({
        where: { id: providerId },
        include: {
          providerProfile: {
            include: { categories: true },
          },
        },
      });

      if (!provider || provider.role !== "PROVIDER") {
        return res.status(404).json({ error: "Provider not found" });
      }

      // ✅ Visibility: suspended providers are invisible to non-admins
      if (!isAdmin(req) && provider.isSuspended) {
        return res.status(404).json({ error: "Provider not found" });
      }

      // isFavorited for consumers
      let isFavorited = false;
      if (req.user?.role === "CONSUMER") {
        const fav = await prisma.favoriteProvider.findUnique({
          where: {
            consumerId_providerId: {
              consumerId: req.user.userId,
              providerId: provider.id,
            },
          },
        });
        isFavorited = !!fav;
      }

      return res.json({
        id: provider.id,
        name: provider.name,
        email: provider.email,
        phone: provider.phone,
        location: provider.location,
        createdAt: provider.createdAt,
        experience: provider.providerProfile?.experience ?? null,
        specialties: provider.providerProfile?.specialties ?? null,
        rating: provider.providerProfile?.rating ?? null,
        reviewCount: provider.providerProfile?.reviewCount ?? 0,
        isFavorited,
        categories:
          provider.providerProfile?.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })) ?? [],
      });
    } catch (err) {
      console.error("GET /providers/:id error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching provider." });
    }
  }
);

// -----------------------------
// Messaging endpoints
// -----------------------------

// Helper to extract user from Authorization header (Bearer token)
function getUserFromAuthHeader(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.split(" ")[1];

  try {
    // Same secret you used in signup/login
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: number;
      role: string;
      email?: string;
    };
    return decoded;
  } catch (err) {
    console.error("JWT verify error in messages route:", err);
    return null;
  }
}

// GET /jobs/:jobId/messages
// Query params:
//   cursor?: number (messageId)   -> fetch older messages before this id
//   limit?: number (default 30, max 100)
app.get(
  "/jobs/:jobId/messages",
  authMiddleware,
  messageLimiter,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId in URL." });

      const { cursor, limit } = req.query as { cursor?: string; limit?: string };
      const take = parsePositiveInt(limit, 30, 100);
      const cursorId = parseOptionalCursorId(cursor);

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      // job visibility (non-admin)
      if (!isAdmin(req)) {
        if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
        if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
      }

      const isOwner = req.user.userId === job.consumerId;

      let hasBid = false;
      if (!isOwner && req.user.role === "PROVIDER") {
        const bid = await prisma.bid.findFirst({
          where: { jobId, providerId: req.user.userId },
          select: { id: true },
        });
        hasBid = !!bid;
      }

      if (!isOwner && !hasBid && !isAdmin(req)) {
        return res.status(403).json({ error: "Not allowed to view messages for this job." });
      }

      const { messageWhereVisible } = visibilityFilters(req);

      // We query newest-first for pagination, then reverse for UI display (oldest->newest)
      const page = await prisma.message.findMany({
        where: { jobId, ...messageWhereVisible },
        orderBy: [{ id: "desc" }],
        take,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: { sender: { select: { id: true, name: true, role: true } } },
      });

      const messagesAsc = [...page].reverse();
      const nextCursor = page.length === take ? page[page.length - 1].id : null;

      return res.json({
        items: messagesAsc.map((m) => ({
          id: m.id,
          jobId: m.jobId,
          senderId: m.senderId,
          text: m.text,
          createdAt: m.createdAt,
          sender: m.sender,
        })),
        pageInfo: {
          limit: take,
          nextCursor, // pass this back as ?cursor=... to fetch older messages
        },
      });
    } catch (err) {
      console.error("GET /jobs/:jobId/messages error:", err);
      return res.status(500).json({ error: "Internal server error while fetching messages." });
    }
  }
);


// POST /jobs/:jobId/messages/read → mark thread as read for current user
app.post("/jobs/:jobId/messages/read", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId in URL." });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        isHidden: true,
        consumer: { select: { isSuspended: true } },
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const isOwner = req.user.userId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: req.user.userId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to mark messages read for this job." });
    }

    // Use latest visible message timestamp as the read cutoff (better than just "now")
    const { messageWhereVisible } = visibilityFilters(req);

    const latest = await prisma.message.findFirst({
      where: { jobId, ...messageWhereVisible },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const readAt = latest?.createdAt ?? new Date();

    const state = await prisma.jobMessageReadState.upsert({
      where: {
        jobId_userId: {
          jobId,
          userId: req.user.userId,
        },
      },
      update: { lastReadAt: readAt },
      create: {
        jobId,
        userId: req.user.userId,
        lastReadAt: readAt,
      },
      select: { jobId: true, userId: true, lastReadAt: true },
    });

    // ✅ Webhook: thread read
    await enqueueWebhookEvent({
      eventType: "thread.read",
      payload: {
        jobId,
        userId: req.user.userId,
        readAt: state.lastReadAt,
      },
    });

    return res.json({
      message: "Thread marked as read.",
      readState: state,
    });
  } catch (err) {
    console.error("POST /jobs/:jobId/messages/read error:", err);
    return res.status(500).json({ error: "Internal server error while marking messages read." });
  }
});

// GET /jobs/:jobId/messages/unread-count → unread messages count for current user
app.get("/jobs/:jobId/messages/unread-count", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId in URL." });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        isHidden: true,
        consumer: { select: { isSuspended: true } },
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const isOwner = req.user.userId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: req.user.userId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to view unread count for this job." });
    }

    const state = await prisma.jobMessageReadState.findUnique({
      where: {
        jobId_userId: {
          jobId,
          userId: req.user.userId,
        },
      },
      select: { lastReadAt: true },
    });

    const lastReadAt = state?.lastReadAt ?? new Date(0);

    const { messageWhereVisible } = visibilityFilters(req);

    // Count only messages AFTER lastReadAt, not sent by me, and still visible
    const unreadCount = await prisma.message.count({
      where: {
        jobId,
        ...messageWhereVisible,
        createdAt: { gt: lastReadAt },
        senderId: { not: req.user.userId },
      },
    });

    return res.json({
      jobId,
      lastReadAt,
      unreadCount,
    });
  } catch (err) {
    console.error("GET /jobs/:jobId/messages/unread-count error:", err);
    return res.status(500).json({ error: "Internal server error while fetching unread count." });
  }
});


// POST /jobs/:jobId/messages → send a new message on a job
app.post("/jobs/:jobId/messages", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId in URL." });
    }

    const { text } = req.body as { text?: string };

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: "Message text is required and cannot be empty.",
      });
    }

    // Fetch job so we know who the consumer is (+ visibility basics)
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        title: true,
        isHidden: true,
        consumer: { select: { isSuspended: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const senderId = req.user.userId;

    // ✅ Enforce participation:
    // - consumer owner OR provider who has bid OR admin
    const isOwner = senderId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: senderId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to message on this job." });
    }

    // Block check (same behavior you had, just now after we know they're a participant)
    if (!isOwner) {
      const blocked = await isBlockedBetween(senderId, job.consumerId);
      if (blocked) {
        return res.status(403).json({
          error: "You cannot send messages on this job because one of you has blocked the other.",
        });
      }
    }

    const message = await prisma.message.create({
      data: {
        jobId,
        senderId,
        text: text.trim(),
      },
    });

    // 🔔 Determine who to notify
    let notifiedUserIds: number[] = [];

    if (senderId === job.consumerId) {
      // Consumer → notify providers who have bids
      const bids = await prisma.bid.findMany({
        where: { jobId },
        select: { providerId: true },
        distinct: ["providerId"],
      });

      for (const b of bids) {
        if (b.providerId !== senderId) {
          notifiedUserIds.push(b.providerId);
          await createNotification({
            userId: b.providerId,
            type: "NEW_MESSAGE",
            content: `New message on job "${job.title}".`,
          });
        }
      }
    } else {
      // Provider → notify consumer
      notifiedUserIds.push(job.consumerId);
      await createNotification({
        userId: job.consumerId,
        type: "NEW_MESSAGE",
        content: `New message on your job "${job.title}".`,
      });
    }

    // ✅ Webhook: message sent
    await enqueueWebhookEvent({
      eventType: "message.sent",
      payload: {
        messageId: message.id,
        jobId,
        senderId,
        text: message.text,
        createdAt: message.createdAt,
        consumerId: job.consumerId,
        notifiedUserIds,
      },
    });

    return res.status(201).json(message);
  } catch (err) {
    console.error("Error creating message:", err);
    return res.status(500).json({
      error: "Internal server error while creating message.",
    });
  }
});

// POST /reports
// Body: { type: "USER" | "JOB" | "MESSAGE", targetId: number, reason: string, details?: string }
app.post("/reports", authMiddleware, reportLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { type, targetId, reason, details } = req.body as {
      type?: string;
      targetId?: number;
      reason?: string;
      details?: string;
    };

    if (!type || !["USER", "JOB", "MESSAGE"].includes(type)) {
      return res.status(400).json({
        error: 'type is required and must be one of "USER", "JOB", or "MESSAGE".',
      });
    }

    if (targetId === undefined || targetId === null || Number.isNaN(Number(targetId))) {
      return res.status(400).json({ error: "targetId is required and must be a valid number." });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "reason is required and cannot be empty." });
    }

    const targetIdNum = Number(targetId);
    let targetUserId: number | null = null;
    let targetJobId: number | null = null;
    let targetMessageId: number | null = null;

    // Validate target exists and set appropriate foreign key
    if (type === "USER") {
      if (targetIdNum === req.user.userId) {
        return res.status(400).json({ error: "You cannot report yourself." });
      }

      const user = await prisma.user.findUnique({ where: { id: targetIdNum } });
      if (!user) return res.status(404).json({ error: "Target user not found." });

      targetUserId = targetIdNum;
    } else if (type === "JOB") {
      const job = await prisma.job.findUnique({ where: { id: targetIdNum } });
      if (!job) return res.status(404).json({ error: "Target job not found." });

      targetJobId = targetIdNum;
    } else if (type === "MESSAGE") {
      const message = await prisma.message.findUnique({ where: { id: targetIdNum } });
      if (!message) return res.status(404).json({ error: "Target message not found." });

      targetMessageId = targetIdNum;
    }

    const report = await prisma.report.create({
      data: {
        reporterId: req.user.userId,
        targetType: type as any,
        targetUserId,
        targetJobId,
        targetMessageId,
        reason: reason.trim(),
        details: details?.trim() || null,
      },
    });

    // ✅ Webhook: report created
    await enqueueWebhookEvent({
      eventType: "report.created",
      payload: {
        reportId: report.id,
        reporterId: report.reporterId,
        targetType: report.targetType,
        targetUserId: report.targetUserId,
        targetJobId: report.targetJobId,
        targetMessageId: report.targetMessageId,
        status: report.status,
        reason: report.reason,
        details: report.details,
        createdAt: report.createdAt,
      },
    });

    return res.status(201).json({
      message: "Report submitted.",
      report: {
        id: report.id,
        targetType: report.targetType,
        targetUserId: report.targetUserId,
        targetJobId: report.targetJobId,
        targetMessageId: report.targetMessageId,
        status: report.status,
        reason: report.reason,
        details: report.details,
        createdAt: report.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /reports error:", err);
    return res.status(500).json({
      error: "Internal server error while submitting report.",
    });
  }
});

// GET /me/reports → list reports created by the current user
app.get(
  "/me/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const reports = await prisma.report.findMany({
        where: { reporterId: req.user.userId },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        reports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          targetUserId: r.targetUserId,
          targetJobId: r.targetJobId,
          targetMessageId: r.targetMessageId,
          status: r.status,
          reason: r.reason,
          details: r.details,
          adminNotes: r.adminNotes,
          createdAt: r.createdAt,
        }))
      );
    } catch (err) {
      console.error("GET /me/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching your reports.",
      });
    }
  }
);


// --- Consumer: Accept a bid ---
// POST /jobs/:jobId/bids/:bidId/accept
app.post("/jobs/:jobId/bids/:bidId/accept", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can accept bids." });
    }

    const jobId = Number(req.params.jobId);
    const bidId = Number(req.params.bidId);

    if (Number.isNaN(jobId) || Number.isNaN(bidId)) {
      return res.status(400).json({ error: "Invalid jobId or bidId parameter" });
    }

    // Fetch job and verify ownership
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, status: true, consumerId: true },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({ error: "You do not own this job." });
    }

    if (job.status !== "OPEN") {
      return res.status(400).json({ error: `Job is not OPEN (current: ${job.status}).` });
    }

    // Ensure bid belongs to this job
    const bid = await prisma.bid.findUnique({
      where: { id: bidId },
      select: { id: true, jobId: true, providerId: true, status: true, amount: true },
    });

    if (!bid || bid.jobId !== job.id) {
      return res.status(404).json({ error: "Bid not found for this job." });
    }

    const previousJobStatus = job.status;

    // Accept in a transaction: accept chosen, decline others, job -> IN_PROGRESS
    const result = await prisma.$transaction(async (tx) => {
      const accepted = await tx.bid.update({
        where: { id: bidId },
        data: { status: "ACCEPTED" },
      });

      await tx.bid.updateMany({
        where: { jobId: job.id, id: { not: bidId }, status: "PENDING" },
        data: { status: "DECLINED" },
      });

      const updatedJob = await tx.job.update({
        where: { id: job.id },
        data: { status: "IN_PROGRESS" },
      });

      return { accepted, updatedJob };
    });

    // 🔔 Notify the winning provider
    await createNotification({
      userId: bid.providerId,
      type: "BID_ACCEPTED",
      content: `Your bid was accepted for "${job.title}".`,
    });

    // ✅ Webhook 1: bid accepted
    await enqueueWebhookEvent({
      eventType: "bid.accepted",
      payload: {
        bidId: result.accepted.id,
        jobId: job.id,
        consumerId: job.consumerId,
        providerId: bid.providerId,
        amount: bid.amount,
        jobTitle: job.title,
        acceptedAt: new Date(),
      },
    });

    // ✅ Webhook 2: job status changed
    await enqueueWebhookEvent({
      eventType: "job.status_changed",
      payload: {
        jobId: result.updatedJob.id,
        consumerId: job.consumerId,
        previousStatus: previousJobStatus,
        newStatus: result.updatedJob.status,
        jobTitle: job.title,
        changedAt: new Date(),
      },
    });

    return res.json({
      message: "Bid accepted. Job is now IN_PROGRESS.",
      job: result.updatedJob,
      acceptedBid: result.accepted,
    });
  } catch (err) {
    console.error("Accept bid error:", err);
    return res.status(500).json({ error: "Internal server error while accepting bid." });
  }
});

// POST /jobs/:jobId/cancel  → consumer cancels a job
app.post("/jobs/:jobId/cancel", async (req, res) => {
  try {
    const user = getUserFromAuthHeader(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Only consumers can cancel jobs
    if (user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can cancel jobs." });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId in URL." });
    }

    // Fetch job & ownership
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        status: true,
        title: true,
        location: true,
        createdAt: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // Ensure this user owns the job
    if (job.consumerId !== user.userId) {
      return res.status(403).json({ error: "You can only cancel jobs that you created." });
    }

    // Only allow cancel if job is OPEN or IN_PROGRESS
    if (job.status !== "OPEN" && job.status !== "IN_PROGRESS") {
      return res.status(400).json({
        error: `Only jobs that are OPEN or IN_PROGRESS can be cancelled. Current status: ${job.status}.`,
      });
    }

    const previousStatus = job.status;

    // Transaction: reject all bids, set job to CANCELLED
    const [_, updatedJob] = await prisma.$transaction([
      prisma.bid.updateMany({
        where: { jobId },
        data: { status: "DECLINED" },
      }),
      prisma.job.update({
        where: { id: jobId },
        data: { status: "CANCELLED" },
        select: {
          id: true,
          title: true,
          location: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    // ✅ Webhook 1: job cancelled
    await enqueueWebhookEvent({
      eventType: "job.cancelled",
      payload: {
        jobId: updatedJob.id,
        consumerId: job.consumerId,
        previousStatus,
        newStatus: updatedJob.status,
        title: updatedJob.title,
        location: updatedJob.location,
        createdAt: updatedJob.createdAt,
        cancelledAt: new Date(),
      },
    });

    // ✅ Webhook 2: job status changed
    await enqueueWebhookEvent({
      eventType: "job.status_changed",
      payload: {
        jobId: updatedJob.id,
        consumerId: job.consumerId,
        previousStatus,
        newStatus: updatedJob.status,
        title: updatedJob.title,
        changedAt: new Date(),
      },
    });

    return res.json({
      message: "Job cancelled successfully.",
      job: updatedJob,
    });
  } catch (err) {
    console.error("Error cancelling job:", err);
    return res.status(500).json({ error: "Internal server error while cancelling job." });
  }
});

// POST /jobs/:jobId/complete  → consumer marks job as completed
app.post("/jobs/:jobId/complete", async (req, res) => {
  try {
    const user = getUserFromAuthHeader(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Only consumers can complete jobs
    if (user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can mark jobs as completed." });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid jobId in URL." });
    }

    // Fetch the job to verify ownership and status
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        status: true,
        title: true,
        location: true,
        createdAt: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // Ensure this user owns the job
    if (job.consumerId !== user.userId) {
      return res.status(403).json({ error: "You can only complete jobs that you created." });
    }

    // Only allow completion if job is IN_PROGRESS
    if (job.status !== "IN_PROGRESS") {
      return res.status(400).json({
        error: `Only jobs that are IN_PROGRESS can be marked as completed. Current status: ${job.status}.`,
      });
    }

    const previousStatus = job.status;

    // Update job status → COMPLETED
    const updatedJob = await prisma.job.update({
      where: { id: jobId },
      data: { status: "COMPLETED" },
      select: {
        id: true,
        title: true,
        location: true,
        status: true,
        createdAt: true,
      },
    });

    // ✅ Webhook 1: job completed
    await enqueueWebhookEvent({
      eventType: "job.completed",
      payload: {
        jobId: updatedJob.id,
        consumerId: job.consumerId,
        previousStatus,
        newStatus: updatedJob.status,
        title: updatedJob.title,
        location: updatedJob.location,
        createdAt: updatedJob.createdAt,
        completedAt: new Date(),
      },
    });

    // ✅ Webhook 2: job status changed
    await enqueueWebhookEvent({
      eventType: "job.status_changed",
      payload: {
        jobId: updatedJob.id,
        consumerId: job.consumerId,
        previousStatus,
        newStatus: updatedJob.status,
        title: updatedJob.title,
        changedAt: new Date(),
      },
    });

    return res.json({
      message: "Job marked as completed.",
      job: updatedJob,
    });
  } catch (err) {
    console.error("Error completing job:", err);
    return res.status(500).json({ error: "Internal server error while completing job." });
  }
});

// POST /jobs/:id/favorite → user favorites a job
app.post("/jobs/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const jobId = Number(req.params.id);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        consumerId: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        isHidden: true,
        consumer: { select: { isSuspended: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // ✅ Visibility (non-admin): hidden jobs / suspended consumers behave like not-found
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const fav = await prisma.favoriteJob.upsert({
      where: {
        userId_jobId: {
          userId: req.user.userId,
          jobId,
        },
      },
      update: {},
      create: {
        userId: req.user.userId,
        jobId,
      },
      select: { userId: true, jobId: true, createdAt: true },
    });

    // ✅ Webhook: job favorited
    await enqueueWebhookEvent({
      eventType: "job.favorited",
      payload: {
        userId: fav.userId,
        jobId: fav.jobId,
        createdAt: fav.createdAt,
        job: {
          id: job.id,
          title: job.title,
          status: job.status,
          location: job.location,
          budgetMin: job.budgetMin,
          budgetMax: job.budgetMax,
          createdAt: job.createdAt,
          consumerId: job.consumerId,
        },
      },
    });

    return res.status(201).json({ message: "Job favorited." });
  } catch (err) {
    console.error("POST /jobs/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while favoriting job.",
    });
  }
});

// DELETE /jobs/:id/favorite → user removes favorite job
app.delete("/jobs/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const jobId = Number(req.params.id);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const result = await prisma.favoriteJob.deleteMany({
      where: {
        userId: req.user.userId,
        jobId,
      },
    });

    // ✅ Webhook: job unfavorited (only if deletion happened)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "job.unfavorited",
        payload: {
          userId: req.user.userId,
          jobId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "Job unfavorited." });
  } catch (err) {
    console.error("DELETE /jobs/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while unfavoriting job.",
    });
  }
});

// GET /notifications
// Query params:
//   cursor?: number (notificationId)
//   limit?: number (default 25, max 100)
app.get("/notifications", authMiddleware, notificationsLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = parsePositiveInt(limit, 25, 100);
    const cursorId = parseOptionalCursorId(cursor);

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ id: "desc" }],
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const nextCursor =
      notifications.length === take ? notifications[notifications.length - 1].id : null;

    return res.json({
      items: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        content: n.content,
        read: n.read,
        createdAt: n.createdAt,
      })),
      pageInfo: { limit: take, nextCursor },
    });
  } catch (err) {
    console.error("List notifications error:", err);
    return res.status(500).json({ error: "Internal server error while fetching notifications." });
  }
});


// POST /notifications/:id/read  → mark a single notification as read
app.post("/notifications/:id/read", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const notifId = Number(req.params.id);
    if (Number.isNaN(notifId)) {
      return res.status(400).json({ error: "Invalid notification id." });
    }

    const notif = await prisma.notification.findUnique({
      where: { id: notifId },
      select: { id: true, userId: true, read: true, type: true, createdAt: true },
    });

    if (!notif || notif.userId !== req.user.userId) {
      return res.status(404).json({ error: "Notification not found." });
    }

    // already read → idempotent response (still OK)
    const updated = notif.read
      ? notif
      : await prisma.notification.update({
          where: { id: notifId },
          data: { read: true },
          select: { id: true, userId: true, read: true, type: true, createdAt: true },
        });

    // ✅ Webhook (only emit when it actually changed)
    if (!notif.read) {
      await enqueueWebhookEvent({
        eventType: "notification.read",
        payload: {
          notificationId: updated.id,
          userId: updated.userId,
          type: updated.type,
          createdAt: updated.createdAt,
          readAt: new Date(),
        },
      });
    }

    return res.json({
      id: updated.id,
      read: true,
    });
  } catch (err) {
    console.error("Mark notification read error:", err);
    return res.status(500).json({ error: "Internal server error while updating notification." });
  }
});

// POST /notifications/read-all  → mark all my notifications as read
app.post("/notifications/read-all", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const result = await prisma.notification.updateMany({
      where: {
        userId: req.user.userId,
        read: false,
      },
      data: { read: true },
    });

    // ✅ Webhook (only if anything changed)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "notification.read_all",
        payload: {
          userId: req.user.userId,
          updatedCount: result.count,
          readAt: new Date(),
        },
      });
    }

    return res.json({
      updatedCount: result.count,
    });
  } catch (err) {
    console.error("Mark all notifications read error:", err);
    return res.status(500).json({ error: "Internal server error while updating notifications." });
  }
});

// POST /users/:id/block → current user blocks another user
app.post("/users/:id/block", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const targetId = Number(req.params.id);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    if (targetId === req.user.userId) {
      return res.status(400).json({ error: "You cannot block yourself." });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, email: true },
    });

    if (!target) {
      return res.status(404).json({ error: "User not found." });
    }

    // Upsert to avoid duplicates
    const block = await prisma.block.upsert({
      where: {
        blockerId_blockedId: {
          blockerId: req.user.userId,
          blockedId: targetId,
        },
      },
      update: {},
      create: {
        blockerId: req.user.userId,
        blockedId: targetId,
      },
      select: {
        id: true,
        blockerId: true,
        blockedId: true,
        createdAt: true,
      },
    });

    // ✅ Webhook: user blocked
    await enqueueWebhookEvent({
      eventType: "user.blocked",
      payload: {
        blockId: block.id,
        blockerId: block.blockerId,
        blockedId: block.blockedId,
        createdAt: block.createdAt,
      },
    });

    return res.json({
      message: "User blocked.",
      block: {
        id: block.id,
        blockerId: block.blockerId,
        blockedId: block.blockedId,
        createdAt: block.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /users/:id/block error:", err);
    return res.status(500).json({ error: "Internal server error while blocking user." });
  }
});

// DELETE /users/:id/block → current user unblocks another user
app.delete("/users/:id/block", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const targetId = Number(req.params.id);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const result = await prisma.block.deleteMany({
      where: {
        blockerId: req.user.userId,
        blockedId: targetId,
      },
    });

    // ✅ Webhook: user unblocked (only if anything changed)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "user.unblocked",
        payload: {
          blockerId: req.user.userId,
          blockedId: targetId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "User unblocked (if they were blocked)." });
  } catch (err) {
    console.error("DELETE /users/:id/block error:", err);
    return res.status(500).json({
      error: "Internal server error while unblocking user.",
    });
  }
});

// GET /me/blocks → list users the current user has blocked
app.get(
  "/me/blocks",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const blocks = await prisma.block.findMany({
        where: { blockerId: req.user.userId },
        include: {
          blocked: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        blocks.map((b) => ({
          id: b.id,
          blockedUser: {
            id: b.blocked.id,
            name: b.blocked.name,
            email: b.blocked.email,
            role: b.blocked.role,
          },
          createdAt: b.createdAt,
        }))
      );
    } catch (err) {
      console.error("GET /me/blocks error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching blocks.",
      });
    }
  }
);

// GET /admin/reports
// Query params:
//   status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED"
//   type?: "USER" | "JOB" | "MESSAGE"
//   page?: number (default 1)
//   pageSize?: number (default 20, max 100)
app.get(
  "/admin/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const {
        status,
        type,
        page = "1",
        pageSize = "20",
      } = req.query as {
        status?: string;
        type?: string;
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(Number(page) || 1, 1);
      const take = Math.min(Number(pageSize) || 20, 100);
      const skip = (pageNum - 1) * take;

      const where: any = {};

      if (status && ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status)) {
        where.status = status;
      }

      if (type && ["USER", "JOB", "MESSAGE"].includes(type)) {
        where.targetType = type;
      }

      const [reports, total] = await prisma.$transaction([
        prisma.report.findMany({
          where,
          include: {
            reporter: true,
            targetUser: true,
            targetJob: true,
            targetMessage: true,
          },
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.report.count({ where }),
      ]);

      const totalPages = Math.ceil(total / take) || 1;

      return res.json({
        page: pageNum,
        pageSize: take,
        total,
        totalPages,
        reports: reports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          status: r.status,
          reason: r.reason,
          details: r.details,
          adminNotes: r.adminNotes,
          createdAt: r.createdAt,
          reporter: {
            id: r.reporter.id,
            name: r.reporter.name,
            email: r.reporter.email,
            role: r.reporter.role,
          },
          targetUser: r.targetUser
            ? {
                id: r.targetUser.id,
                name: r.targetUser.name,
                email: r.targetUser.email,
                role: r.targetUser.role,
              }
            : null,
          targetJob: r.targetJob
            ? {
                id: r.targetJob.id,
                title: r.targetJob.title,
                consumerId: r.targetJob.consumerId,
              }
            : null,
          targetMessage: r.targetMessage
            ? {
                id: r.targetMessage.id,
                jobId: r.targetMessage.jobId,
                senderId: r.targetMessage.senderId,
                text: r.targetMessage.text,
              }
            : null,
        })),
      });
    } catch (err) {
      console.error("GET /admin/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching reports.",
      });
    }
  }
);

function publicWebhookEndpoint(ep: {
  id: number;
  url: string;
  enabled: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: ep.id,
    url: ep.url,
    enabled: ep.enabled,
    events: ep.events,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}


// POST /admin/webhooks/endpoints
app.post("/admin/webhooks/endpoints", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { url, events } = req.body as { url?: string; events?: string[] };
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url is required." });
    if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: "events[] is required." });

    const secret = crypto.randomBytes(32).toString("hex");

    const ep = await prisma.webhookEndpoint.create({
      data: { url, secret, events, enabled: true },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    await prisma.adminAction
      .create({
        data: {
          adminId: req.user!.userId,
          type: "WEBHOOK_ENDPOINT_CREATED" as any,
          entityId: ep.id,
          notes: `Webhook endpoint created: url=${ep.url} enabled=${ep.enabled} events=${JSON.stringify(ep.events)}`,
        },
      })
      .catch(() => null);

    // ✅ Return secret ONCE, separate from endpoint object
    return res.json({ endpoint: publicWebhookEndpoint(ep), secret });
  } catch (err) {
    console.error("Create webhook endpoint error:", err);
    return res.status(500).json({ error: "Internal server error creating webhook endpoint." });
  }
});

// GET /admin/webhooks/endpoints
app.get("/admin/webhooks/endpoints", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const endpoints = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    return res.json({ endpoints: endpoints.map(publicWebhookEndpoint) });
  } catch (err) {
    console.error("List webhook endpoints error:", err);
    return res.status(500).json({ error: "Internal server error listing webhook endpoints." });
  }
});


// PATCH /admin/webhooks/endpoints/:id
app.patch("/admin/webhooks/endpoints/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid endpoint id." });

    const { url, enabled, events } = req.body as { url?: string; enabled?: boolean; events?: string[] };

    const before = await prisma.webhookEndpoint.findUnique({
      where: { id },
      select: { id: true, url: true, enabled: true, events: true},
    });

    const ep = await prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(url ? { url } : {}),
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(Array.isArray(events) ? { events } : {}),
      },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    // ✅ Audit (AdminAction) — no webhook
    await prisma.adminAction.create({
      data: {
        adminId: req.user!.userId,
        type: "WEBHOOK_ENDPOINT_UPDATED" as any, // only if your enum includes it
        entityId: ep.id,
        notes: `Webhook endpoint updated. before=${JSON.stringify(before)} after=${JSON.stringify({
          id: ep.id,
          url: ep.url,
          enabled: ep.enabled,
          events: ep.events,
        })}`,
      },
    }).catch(() => null);

    return res.json({ endpoint: publicWebhookEndpoint(ep) });
  } catch (err) {
    console.error("Update webhook endpoint error:", err);
    return res.status(500).json({ error: "Internal server error updating webhook endpoint." });
  }
});

// POST /admin/webhooks/endpoints/:id/rotate-secret
app.post("/admin/webhooks/endpoints/:id/rotate-secret", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid endpoint id." });

    const exists = await prisma.webhookEndpoint.findUnique({
      where: { id },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });
    if (!exists) return res.status(404).json({ error: "Webhook endpoint not found." });

    const newSecret = crypto.randomBytes(32).toString("hex");

    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: newSecret },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    await prisma.adminAction
      .create({
        data: {
          adminId: req.user!.userId,
          type: "WEBHOOK_ENDPOINT_SECRET_ROTATED" as any, // add to enum later if you want
          entityId: updated.id,
          notes: `Webhook endpoint secret rotated: url=${updated.url}`,
        },
      })
      .catch(() => null);

    // ✅ Return secret ONCE here
    return res.json({ endpoint: publicWebhookEndpoint(updated), secret: newSecret });
  } catch (err) {
    console.error("Rotate webhook secret error:", err);
    return res.status(500).json({ error: "Internal server error rotating webhook secret." });
  }
});


// PATCH /admin/reports/:id
// Body: { status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", adminNotes?: string }
app.patch("/admin/reports/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const reportId = Number(req.params.id);
    if (Number.isNaN(reportId)) {
      return res.status(400).json({ error: "Invalid report id." });
    }

    const { status, adminNotes } = req.body as { status?: string; adminNotes?: string };

    if (!status || !["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status)) {
      return res.status(400).json({
        error: 'status is required and must be one of "OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED".',
      });
    }

    const existing = await prisma.report.findUnique({ where: { id: reportId } });
    if (!existing) {
      return res.status(404).json({ error: "Report not found." });
    }

    const previousStatus = existing.status;

    const updated = await prisma.report.update({
      where: { id: reportId },
      data: {
        status: status as any,
        adminNotes: adminNotes?.trim() ?? undefined,
        handledByAdminId: req.user!.userId,
        handledAt: new Date(),
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "REPORT_STATUS_CHANGED",
      reportId,
      notes: `Status -> ${status}${adminNotes ? ` | ${adminNotes.trim()}` : ""}`,
    });

    // ✅ Webhook: report status changed
    await enqueueWebhookEvent({
      eventType: "report.status_changed",
      payload: {
        reportId: updated.id,
        previousStatus,
        newStatus: updated.status,
        targetType: updated.targetType,
        targetUserId: updated.targetUserId,
        targetJobId: updated.targetJobId,
        targetMessageId: updated.targetMessageId,
        reason: updated.reason,
        details: updated.details,
        adminNotes: updated.adminNotes,
        handledByAdminId: updated.handledByAdminId,
        handledAt: updated.handledAt,
        changedAt: new Date(),
      },
    });

    return res.json({
      message: "Report updated.",
      report: {
        id: updated.id,
        targetType: updated.targetType,
        status: updated.status,
        reason: updated.reason,
        details: updated.details,
        adminNotes: updated.adminNotes,
        handledByAdminId: updated.handledByAdminId,
        handledAt: updated.handledAt,
        targetUserId: updated.targetUserId,
        targetJobId: updated.targetJobId,
        targetMessageId: updated.targetMessageId,
        createdAt: updated.createdAt,
      },
    });
  } catch (err) {
    console.error("PATCH /admin/reports/:id error:", err);
    return res.status(500).json({ error: "Internal server error while updating report." });
  }
});

// GET /admin/stats/reports
// Optional query param:
//   window=24h | 7d | 30d | all   (default: 24h)
app.get(
  "/admin/stats/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      // ---- Time windows (absolute + selectable window) ----
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const { window = "24h" } = req.query as { window?: string };

      let windowStart: Date | null = last24h; // default
      if (window === "7d") windowStart = last7d;
      if (window === "30d") windowStart = last30d;
      if (window === "all") windowStart = null;

      const windowWhere = windowStart ? { createdAt: { gte: windowStart } } : {};

      // 1) Total reports
      const total = await prisma.report.count();

      // 2) By status (OPEN / IN_REVIEW / RESOLVED / DISMISSED)
      const byStatusRaw = await prisma.report.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      const byStatus = {
        OPEN: 0,
        IN_REVIEW: 0,
        RESOLVED: 0,
        DISMISSED: 0,
      } as Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>;

      for (const row of byStatusRaw) {
        byStatus[row.status as keyof typeof byStatus] = row._count._all;
      }

      // 3) By target type (USER / JOB / MESSAGE)
      const byTypeRaw = await prisma.report.groupBy({
        by: ["targetType"],
        _count: { _all: true },
      });

      const byTargetType = {
        USER: 0,
        JOB: 0,
        MESSAGE: 0,
      } as Record<"USER" | "JOB" | "MESSAGE", number>;

      for (const row of byTypeRaw) {
        byTargetType[row.targetType as keyof typeof byTargetType] = row._count._all;
      }

      // 3b) Status counts by targetType (matrix, all-time)
      const byTypeStatusRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        _count: { _all: true },
      });

      const statusCountsByTargetType: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetType[t][s] = row._count._all;
      }

      // 3c) Status counts by targetType (matrix, time-windowed)
      const byTypeStatusWindowRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        where: windowWhere,
        _count: { _all: true },
      });

      const statusCountsByTargetTypeWindow: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusWindowRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetTypeWindow[t][s] = row._count._all;
      }

      // 4) New reports in time windows (absolute)
      const [createdLast24h, createdLast7d, createdLast30d] =
        await prisma.$transaction([
          prisma.report.count({ where: { createdAt: { gte: last24h } } }),
          prisma.report.count({ where: { createdAt: { gte: last7d } } }),
          prisma.report.count({ where: { createdAt: { gte: last30d } } }),
        ]);

      // 5) Top reported users (based on targetUserId)
      // Only reports where targetType=USER and targetUserId is not null
      const topUsersRaw = await prisma.report.groupBy({
        by: ["targetUserId"],
        where: {
          targetType: "USER",
          targetUserId: { not: null },
        },
        _count: {
          targetUserId: true, // count rows in each group
        },
        orderBy: {
          _count: {
            targetUserId: "desc",
          },
        },
        take: 10,
      });

      const userIds = topUsersRaw
        .map((r) => r.targetUserId)
        .filter((id): id is number => typeof id === "number");

      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true, role: true },
          })
        : [];

      const userMap = new Map(users.map((u) => [u.id, u]));

      const topReportedUsers = topUsersRaw.map((r) => ({
        user: userMap.get(r.targetUserId as number) ?? {
          id: r.targetUserId,
          name: null,
          email: null,
          role: null,
        },
        reportCount: r._count.targetUserId,
      }));

      return res.json({
        total,
        byStatus,
        byTargetType,
        statusCountsByTargetType,
        window,
        statusCountsByTargetTypeWindow,
        created: {
          last24h: createdLast24h,
          last7d: createdLast7d,
          last30d: createdLast30d,
        },
        topReportedUsers,
      });
    } catch (err) {
      console.error("GET /admin/stats/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching report stats.",
      });
    }
  }
);

// POST /admin/users/:id/suspend
// Body: { reason?: string, reportId?: number }
app.post("/admin/users/:id/suspend", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const userId = Number(req.params.id);
    if (Number.isNaN(userId)) return res.status(400).json({ error: "Invalid user id." });

    const body = (req.body ?? {}) as { reason?: string; reportId?: number };
    const reason = body.reason;
    const reportId = body.reportId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isSuspended: true },
    });
    if (!user) return res.status(404).json({ error: "User not found." });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspendedReason: reason?.trim() || null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: AdminActionType.USER_SUSPENDED,
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: userId,
      notes: reason?.trim() || null,
    });

    // ✅ Webhook: user suspended
    await enqueueWebhookEvent({
      eventType: "user.suspended",
      payload: {
        userId: updated.id,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        suspendedAt: updated.suspendedAt,
        suspendedReason: updated.suspendedReason,
        suspendedByAdminId: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
      },
    });

    return res.json({
      message: "User suspended.",
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        suspendedAt: updated.suspendedAt,
        suspendedReason: updated.suspendedReason,
      },
    });
  } catch (err) {
    console.error("POST /admin/users/:id/suspend error:", err);
    return res.status(500).json({ error: "Internal server error while suspending user." });
  }
});

// POST /admin/users/:id/unsuspend
app.post("/admin/users/:id/unsuspend", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const userId = Number(req.params.id);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isSuspended: true, suspendedAt: true, suspendedReason: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.isSuspended) {
      return res.status(400).json({ error: "User is not suspended" });
    }

    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          isSuspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      }),
      prisma.adminAction.create({
        data: {
          adminId: req.user!.userId,
          type: AdminActionType.USER_UNSUSPENDED,
          entityId: userId,
          notes: "User unsuspended by admin",
        },
      }),
    ]);

    // ✅ Webhook: user unsuspended
    await enqueueWebhookEvent({
      eventType: "user.unsuspended",
      payload: {
        userId: updated.id,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        unsuspendedByAdminId: req.user!.userId,
        unsuspendedAt: new Date(),
      },
    });

    return res.json({
      message: "User unsuspended",
      user: {
        id: updated.id,
        isSuspended: updated.isSuspended,
      },
    });
  } catch (err) {
    console.error("POST /admin/users/:id/unsuspend error:", err);
    return res.status(500).json({
      error: "Internal server error while unsuspending user.",
    });
  }
});

// POST /admin/jobs/:id/hide
// Body: { reportId?: number, notes?: string }
app.post("/admin/jobs/:id/hide", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const jobId = Number(req.params.id);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid job id." });

    const { reportId, notes } = req.body as { reportId?: number; notes?: string };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        consumerId: true,
        isHidden: true,
      },
    });
    if (!job) return res.status(404).json({ error: "Job not found." });

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        isHidden: true,
        hiddenAt: new Date(),
        hiddenById: req.user!.userId,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "JOB_HIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: jobId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: job hidden
    await enqueueWebhookEvent({
      eventType: "job.hidden",
      payload: {
        jobId: updated.id,
        title: updated.title,
        status: updated.status,
        location: updated.location,
        budgetMin: updated.budgetMin,
        budgetMax: updated.budgetMax,
        createdAt: updated.createdAt,
        consumerId: updated.consumerId,
        hiddenAt: updated.hiddenAt,
        hiddenById: updated.hiddenById,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    return res.json({ message: "Job hidden.", job: updated });
  } catch (err) {
    console.error("POST /admin/jobs/:id/hide error:", err);
    return res.status(500).json({ error: "Internal server error while hiding job." });
  }
});

// POST /admin/jobs/:id/unhide
app.post("/admin/jobs/:id/unhide", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const jobId = Number(req.params.id);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid job id." });

    const { reportId, notes } = req.body as { reportId?: number; notes?: string };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        consumerId: true,
        isHidden: true,
        hiddenAt: true,
        hiddenById: true,
      },
    });
    if (!job) return res.status(404).json({ error: "Job not found." });

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        isHidden: false,
        hiddenAt: null,
        hiddenById: null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "JOB_UNHIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: jobId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: job unhidden
    await enqueueWebhookEvent({
      eventType: "job.unhidden",
      payload: {
        jobId: updated.id,
        title: updated.title,
        status: updated.status,
        location: updated.location,
        budgetMin: updated.budgetMin,
        budgetMax: updated.budgetMax,
        createdAt: updated.createdAt,
        consumerId: updated.consumerId,
        unhiddenAt: new Date(),
        unhiddenById: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    return res.json({ message: "Job unhidden.", job: updated });
  } catch (err) {
    console.error("POST /admin/jobs/:id/unhide error:", err);
    return res.status(500).json({ error: "Internal server error while unhiding job." });
  }
});

// POST /admin/messages/:id/hide
app.post("/admin/messages/:id/hide", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const messageId = Number(req.params.id);
    if (Number.isNaN(messageId)) return res.status(400).json({ error: "Invalid message id." });

    const { reportId, notes } = req.body as { reportId?: number; notes?: string };

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        jobId: true,
        senderId: true,
        text: true,
        createdAt: true,
        isHidden: true,
      },
    });
    if (!msg) return res.status(404).json({ error: "Message not found." });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isHidden: true,
        hiddenAt: new Date(),
        hiddenById: req.user!.userId,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "MESSAGE_HIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: messageId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: message hidden
    await enqueueWebhookEvent({
      eventType: "message.hidden",
      payload: {
        messageId: updated.id,
        jobId: updated.jobId,
        senderId: updated.senderId,
        createdAt: updated.createdAt,
        hiddenAt: updated.hiddenAt,
        hiddenById: updated.hiddenById,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    return res.json({ message: "Message hidden.", messageObj: updated });
  } catch (err) {
    console.error("POST /admin/messages/:id/hide error:", err);
    return res.status(500).json({ error: "Internal server error while hiding message." });
  }
});

// POST /admin/messages/:id/unhide
app.post("/admin/messages/:id/unhide", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const messageId = Number(req.params.id);
    if (Number.isNaN(messageId)) return res.status(400).json({ error: "Invalid message id." });

    const { reportId, notes } = req.body as { reportId?: number; notes?: string };

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        jobId: true,
        senderId: true,
        createdAt: true,
        isHidden: true,
        hiddenAt: true,
        hiddenById: true,
      },
    });
    if (!msg) return res.status(404).json({ error: "Message not found." });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isHidden: false,
        hiddenAt: null,
        hiddenById: null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "MESSAGE_UNHIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: messageId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: message unhidden
    await enqueueWebhookEvent({
      eventType: "message.unhidden",
      payload: {
        messageId: updated.id,
        jobId: updated.jobId,
        senderId: updated.senderId,
        createdAt: updated.createdAt,
        unhiddenAt: new Date(),
        unhiddenById: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    return res.json({ message: "Message unhidden.", messageObj: updated });
  } catch (err) {
    console.error("POST /admin/messages/:id/unhide error:", err);
    return res.status(500).json({ error: "Internal server error while unhiding message." });
  }
});

// GET /admin/actions
// Query params:
//   type?: AdminActionType
//   reportId?: number
//   adminId?: number
//   page?: number (default 1)
//   pageSize?: number (default 20, max 100)
app.get(
  "/admin/actions",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const { type, reportId, adminId, page = "1", pageSize = "20" } = req.query as {
        type?: string;
        reportId?: string;
        adminId?: string;
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(Number(page) || 1, 1);
      const take = Math.min(Number(pageSize) || 20, 100);
      const skip = (pageNum - 1) * take;

      const where: any = {};

      if (type) where.type = type;
      const reportIdNum = Number(reportId);
      if (!Number.isNaN(reportIdNum) && reportId) where.reportId = reportIdNum;

      const adminIdNum = Number(adminId);
      if (!Number.isNaN(adminIdNum) && adminId) where.adminId = adminIdNum;

      const actions = await prisma.adminAction.findMany({
        where,
        include: {
          admin: { select: { id: true, name: true, email: true, role: true } },
          report: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      });

      const total = await prisma.adminAction.count({ where });


      return res.json({
        page: pageNum,
        pageSize: take,
        total,
        totalPages: Math.ceil(total / take) || 1,
        actions: actions.map((a) => ({
          id: a.id,
          type: a.type,
          entityId: a.entityId,
          notes: a.notes,
          createdAt: a.createdAt,
          admin: a.admin,
          reportId: a.reportId,
        })),
      });
    } catch (err) {
      console.error("GET /admin/actions error:", err);
      return res.status(500).json({ error: "Internal server error while fetching admin actions." });
    }
  }
);

// GET /admin/dashboard/overview?window=24h|7d|30d|all
app.get(
  "/admin/dashboard/overview",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const { window = "24h" } = req.query as { window?: string };
      let windowStart: Date | null = last24h;
      if (window === "7d") windowStart = last7d;
      if (window === "30d") windowStart = last30d;
      if (window === "all") windowStart = null;

      const windowWhere = windowStart ? { createdAt: { gte: windowStart } } : {};

      // --- Report stats (same logic as /admin/stats/reports) ---
      const total = await prisma.report.count();

      const byStatusRaw = await prisma.report.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      const byStatus = {
        OPEN: 0,
        IN_REVIEW: 0,
        RESOLVED: 0,
        DISMISSED: 0,
      } as Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>;

      for (const row of byStatusRaw) {
        byStatus[row.status as keyof typeof byStatus] = row._count._all;
      }

      const byTypeRaw = await prisma.report.groupBy({
        by: ["targetType"],
        _count: { _all: true },
      });

      const byTargetType = {
        USER: 0,
        JOB: 0,
        MESSAGE: 0,
      } as Record<"USER" | "JOB" | "MESSAGE", number>;

      for (const row of byTypeRaw) {
        byTargetType[row.targetType as keyof typeof byTargetType] = row._count._all;
      }

      const byTypeStatusRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        _count: { _all: true },
      });

      const statusCountsByTargetType: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetType[t][s] = row._count._all;
      }

      const byTypeStatusWindowRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        where: windowWhere,
        _count: { _all: true },
      });

      const statusCountsByTargetTypeWindow: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusWindowRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetTypeWindow[t][s] = row._count._all;
      }

      const [createdLast24h, createdLast7d, createdLast30d] =
        await prisma.$transaction([
          prisma.report.count({ where: { createdAt: { gte: last24h } } }),
          prisma.report.count({ where: { createdAt: { gte: last7d } } }),
          prisma.report.count({ where: { createdAt: { gte: last30d } } }),
        ]);

      // --- Recent reports (10) ---
      const recentReports = await prisma.report.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          reporter: { select: { id: true, name: true, email: true, role: true } },
          handledByAdmin: { select: { id: true, name: true, email: true, role: true } },
        },
      });

      // --- Recent admin actions (10) ---
      const recentActions = await prisma.adminAction.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          admin: { select: { id: true, name: true, email: true, role: true } },
        },
      });

      // --- Moderation counts ---
      const [suspendedUsers, hiddenJobs, hiddenMessages] = await prisma.$transaction([
        prisma.user.count({ where: { isSuspended: true } }),
        prisma.job.count({ where: { isHidden: true } }),
        prisma.message.count({ where: { isHidden: true } }),
      ]);

      return res.json({
        window,
        reports: {
          total,
          byStatus,
          byTargetType,
          statusCountsByTargetType,
          statusCountsByTargetTypeWindow,
          created: {
            last24h: createdLast24h,
            last7d: createdLast7d,
            last30d: createdLast30d,
          },
        },
        moderation: {
          suspendedUsers,
          hiddenJobs,
          hiddenMessages,
        },
        recentReports: recentReports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          status: r.status,
          reason: r.reason,
          createdAt: r.createdAt,
          reporter: r.reporter,
          handledByAdmin: r.handledByAdmin,
          handledAt: r.handledAt,
        })),
        recentActions: recentActions.map((a) => ({
          id: a.id,
          type: a.type,
          entityId: a.entityId,
          notes: a.notes,
          createdAt: a.createdAt,
          admin: a.admin,
          reportId: a.reportId,
        })),
      });
    } catch (err) {
      console.error("GET /admin/dashboard/overview error:", err);
      return res.status(500).json({ error: "Internal server error while fetching admin overview." });
    }
  }
);


// POST /admin/impersonate/stop
// IMPORTANT: Call this USING THE IMPERSONATION TOKEN (not the real admin token).
app.post("/admin/impersonate/stop", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    // This endpoint is ONLY for impersonated sessions
    if (!req.user.isImpersonated || !req.user.impersonatedByAdminId) {
      return res.status(400).json({ error: "Not currently impersonating." });
    }

    const adminId = req.user.impersonatedByAdminId; // real admin who started impersonation
    const targetUserId = req.user.userId; // user being impersonated

    await prisma.adminAction.create({
      data: {
        adminId,
        type: AdminActionType.ADMIN_IMPERSONATION_STOPPED,
        entityId: targetUserId,
        notes: `Impersonation stopped for userId=${targetUserId}`,
      },
    });

    // ✅ Webhook: impersonation stopped
    await enqueueWebhookEvent({
      eventType: "admin.impersonation_stopped",
      payload: {
        adminId,
        targetUserId,
        stoppedAt: new Date(),
      },
    });

    return res.json({
      message: "Impersonation stopped (logged). Discard the impersonation token and use the original admin token.",
    });
  } catch (err) {
    console.error("Admin impersonate stop error:", err);
    return res.status(500).json({ error: "Internal server error while stopping impersonation." });
  }
});

// POST /admin/impersonate/:userId
app.post("/admin/impersonate/:userId(\\d+)", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const targetUserId = Number(req.params.userId);
    if (Number.isNaN(targetUserId)) {
      return res.status(400).json({ error: "Invalid userId parameter." });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true, isSuspended: true },
    });

    if (!target) return res.status(404).json({ error: "Target user not found." });

    if (target.role === "ADMIN") {
      return res.status(400).json({ error: "Cannot impersonate an ADMIN user." });
    }

    const adminId = req.user!.userId;

    const token = jwt.sign(
      {
        userId: target.id,
        role: target.role,
        isImpersonated: true,
        impersonatedByAdminId: adminId,
      },
      process.env.JWT_SECRET as string,
      { expiresIn: "30m" }
    );

    await prisma.adminAction.create({
      data: {
        adminId,
        type: AdminActionType.ADMIN_IMPERSONATION_STARTED,
        entityId: target.id,
        notes: `Impersonation started for userId=${target.id} (${target.email}). Suspended=${target.isSuspended}`,
      },
    });

    // ✅ Webhook: impersonation started
    await enqueueWebhookEvent({
      eventType: "admin.impersonation_started",
      payload: {
        adminId,
        targetUserId: target.id,
        targetEmail: target.email,
        targetRole: target.role,
        targetIsSuspended: target.isSuspended,
        startedAt: new Date(),
        expiresIn: "30m",
      },
    });

    return res.json({
      message: "Impersonation token issued.",
      token,
      target: {
        id: target.id,
        role: target.role,
        email: target.email,
        isSuspended: target.isSuspended,
      },
      expiresIn: "30m",
    });
  } catch (err) {
    console.error("Admin impersonate start error:", err);
    return res.status(500).json({ error: "Internal server error while starting impersonation." });
  }
});

const DELIVERY_INTERVAL_MS = 3000;
const DELIVERY_TIMEOUT_MS = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS ?? 5000);
const WEBHOOK_MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5);

// GET /admin/webhooks/deliveries
// Supports filters + cursor pagination
// Query params:
//   status=FAILED|PENDING|PROCESSING|SUCCESS
//   endpointId=9
//   event=webhook.test (partial match)
//   take=50 (max 100)
//   cursor=123 (delivery id)
// GET /admin/webhooks/deliveries
app.get("/admin/webhooks/deliveries", authMiddleware, async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  try {
    if (!requireAdmin(req, res)) return;

    const takeRaw = Number(req.query.take ?? 50);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 50;

    const cursorRaw = req.query.cursor;
    const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;
    const hasCursor = Number.isFinite(cursor);

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const endpointIdRaw = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
    const endpointId = endpointIdRaw ? Number(endpointIdRaw) : undefined;
    const event = typeof req.query.event === "string" ? req.query.event : undefined;

    const where: any = {};
    if (status) where.status = status;
    if (Number.isFinite(endpointId)) where.endpointId = endpointId;
    if (event) where.event = { contains: event, mode: "insensitive" };

    const deliveries = await prisma.webhookDelivery.findMany({
      where,
      take,
      ...(hasCursor ? { skip: 1, cursor: { id: cursor as number } } : {}),
      orderBy: { id: "desc" },
      include: {
        endpoint: {
          select: {
            id: true,
            url: true,
            events: true,
            enabled: true,
            // ❌ removed: name (doesn't exist in your schema)
          },
        },
      },
    });

    const items = deliveries.map((d) => {
      const payload = d.payload as any;

      return {
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,

        // ✅ observability fields (no any-casts needed)
        lastStatusCode: d.lastStatusCode ?? null,
        lastAttemptAt: d.lastAttemptAt ?? null,
        deliveredAt: d.deliveredAt ?? null,
        nextAttempt: d.nextAttempt ?? null,

        endpoint: {
          id: d.endpoint.id,
          url: d.endpoint.url,
          enabled: d.endpoint.enabled,
          subscribedEvents: d.endpoint.events,
        },

        context: {
          jobId: payload?.jobId ?? payload?.job?.id ?? null,
          jobTitle: payload?.title ?? payload?.job?.title ?? null,
          userId: payload?.userId ?? payload?.consumerId ?? payload?.providerId ?? null,
        },

        payload,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
    });

    return res.json({
      items,
      nextCursor: items.length === take ? items[items.length - 1].id : null,
    });
  } catch (err) {
    console.error("List webhook deliveries error:", err);
    return res.status(500).json({
      error: "Internal server error listing webhook deliveries.",
    });
  }
});

// GET /admin/webhooks/deliveries/:id
// Returns the delivery + endpoint + attemptLogs (latest 200)
app.get("/admin/webhooks/deliveries/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid delivery id." });
    }

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id },
      include: {
        endpoint: {
          select: {
            id: true,
            url: true,
            events: true,
            enabled: true,
            // ❌ removed: name (doesn't exist in your schema)
          },
        },
        attemptLogs: {
          orderBy: [{ attemptNumber: "asc" }, { startedAt: "asc" }],
          take: 200,
        },
      },
    });

    if (!delivery) {
      return res.status(404).json({ error: "Webhook delivery not found." });
    }

    const payload = delivery.payload as any;

    return res.json({
      id: delivery.id,
      event: delivery.event,
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.lastError,

      lastStatusCode: delivery.lastStatusCode ?? null,
      lastAttemptAt: delivery.lastAttemptAt ?? null,
      deliveredAt: delivery.deliveredAt ?? null,
      nextAttempt: delivery.nextAttempt ?? null,

      endpoint: {
        id: delivery.endpoint.id,
        url: delivery.endpoint.url,
        enabled: delivery.endpoint.enabled,
        subscribedEvents: delivery.endpoint.events,
      },

      context: {
        jobId: payload?.jobId ?? payload?.job?.id ?? null,
        jobTitle: payload?.title ?? payload?.job?.title ?? null,
        userId: payload?.userId ?? payload?.consumerId ?? payload?.providerId ?? null,
      },

      payload,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,

      attemptLogs: delivery.attemptLogs,
    });
  } catch (err) {
    console.error("Get webhook delivery error:", err);
    return res.status(500).json({
      error: "Internal server error fetching webhook delivery.",
    });
  }
});

// --- Global error handler (keep at the end, after routes) ---
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);

  const status = typeof err?.status === "number" ? err.status : 500;
  const message =
    err?.message && typeof err.message === "string"
      ? err.message
      : "Internal server error";

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== "production" ? { stack: String(err?.stack ?? "") } : {}),
  });
});

// GET /admin/webhooks/ui
// Lightweight admin dashboard (no separate frontend).
// It expects an Admin JWT in localStorage under "adminToken".
app.get("/admin/webhooks/ui", async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Webhooks Admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    input, select, button, textarea { padding: 8px; font-size: 14px; }
    button { cursor: pointer; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 8px; font-size: 13px; vertical-align: top; }
    tr:hover { background: #fafafa; }
    .muted { color: #666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid #ddd; }
    .ok { border-color: #9ae6b4; }
    .bad { border-color: #feb2b2; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #f7f7f7; padding: 10px; border-radius: 8px; }
  </style>
</head>
<body>
  <h2>Webhooks Admin</h2>

  <div class="card">
    <div class="row">
      <label>
        Admin Token (JWT)
        <input id="token" placeholder="paste admin token here" style="min-width:420px" />
      </label>

      <label>
        Status
        <select id="status">
          <option value="">(any)</option>
          <option value="PENDING">PENDING</option>
          <option value="PROCESSING">PROCESSING</option>
          <option value="SUCCESS">SUCCESS</option>
          <option value="FAILED">FAILED</option>
        </select>
      </label>

      <label>
        Endpoint ID
        <input id="endpointId" placeholder="e.g. 9" style="width:120px" />
      </label>

      <label>
        Event contains
        <input id="event" placeholder="e.g. webhook.test" style="width:220px" />
      </label>

      <button id="saveToken">Save Token</button>
      <button id="refresh">Refresh</button>
      <button id="loadMore">Load more</button>
    </div>

    <p class="muted" style="margin:10px 0 0;">
      Tip: token is stored locally in your browser. Requests send <span class="mono">Authorization: Bearer &lt;token&gt;</span>.
    </p>
  </div>

  <div class="grid">
    <div class="card">
      <h3 style="margin-top:0;">Deliveries</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Event</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody id="deliveries"></tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Delivery details</h3>
      <div id="detail" class="muted">Click a delivery on the left.</div>
    </div>
  </div>

<script>
  // ✅ quick sanity check: if you don't see this, script isn't running
  console.log("[admin webhooks ui] script loaded");

  const tokenEl = document.getElementById("token");
  const statusEl = document.getElementById("status");
  const endpointIdEl = document.getElementById("endpointId");
  const eventEl = document.getElementById("event");
  const deliveriesEl = document.getElementById("deliveries"); // TBODY
  const detailEl = document.getElementById("detail");

  let nextCursor = null;

  function getToken() {
    const typed = (tokenEl.value || "").trim();
    if (typed) return typed;
    return (localStorage.getItem("adminToken") || "").trim();
  }

  function qs(params) {
    const u = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && String(v).length) u.set(k, String(v));
    });
    const s = u.toString();
    return s ? "?" + s : "";
  }

  function short(s) {
    s = String(s || "");
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }

  // ✅ FIXED: this version will not crash parsing
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  function statusPill(status) {
    const cls = (status === "SUCCESS") ? "ok" : (status === "FAILED") ? "bad" : "";
    return "<span class='pill " + cls + "'>" + escapeHtml(status) + "</span>";
  }

  async function fetchDeliveryDetail(id) {
    // If you already have this elsewhere, you can remove this stub.
    // Leaving as no-op so clicks won't throw.
    detailEl.innerHTML = "<div class='muted'>Detail loading not implemented in this snippet.</div>";
  }

  async function fetchDeliveries(opts) {
    const reset = opts && opts.reset === true;

    const token = getToken();
    if (!token) {
      alert("Paste your admin token first, click Save Token, then click Refresh.");
      return;
    }

    if (reset) {
      deliveriesEl.innerHTML = "";
      nextCursor = null;
      detailEl.innerHTML = "<div class='muted'>Click a delivery on the left.</div>";
    }

    const params = {
      take: 50,
      cursor: nextCursor,
      status: statusEl.value || undefined,
      endpointId: (endpointIdEl.value || "").trim() || undefined,
      event: (eventEl.value || "").trim() || undefined,
    };

    const url = "/admin/webhooks/deliveries" + qs(params);

    const r = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
    });

    if (r.status === 304) return;

    if (!r.ok) {
      const text = await r.text();
      console.error("Deliveries fetch failed:", r.status, text);
      alert("Failed to load deliveries: " + r.status + "\\n" + text);
      return;
    }

    const data = await r.json();

    // ✅ backend returns an ARRAY, but older code expected { items: [...] }
    const items = Array.isArray(data) ? data : (data.items || []);
    nextCursor = Array.isArray(data) ? null : (data.nextCursor ?? null);


    console.log("Loaded deliveries:", items.length);

    for (const d of items) {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";

      tr.innerHTML =
        "<td class='mono'>" + escapeHtml(d.id) + "</td>" +
        "<td>" + escapeHtml(d.event) + "</td>" +
        "<td>" + statusPill(d.status) + "</td>" +
        "<td class='mono'>" + escapeHtml(d.attempts ?? "") + "</td>" +
        "<td class='mono'>" +
          escapeHtml(d.lastStatusCode ?? "") + " " +
          escapeHtml(short(d.lastError ?? "")) +
        "</td>" +
        "<td class='mono'>" + escapeHtml(d.endpoint?.id ?? d.endpointId ?? "") + "</td>";

      tr.addEventListener("click", function () {
        fetchDeliveryDetail(d.id);
      });

      deliveriesEl.appendChild(tr);
    }
  }

  // token persistence
  const saved = localStorage.getItem("adminToken");
  if (saved) tokenEl.value = saved;

  document.getElementById("saveToken").addEventListener("click", () => {
    localStorage.setItem("adminToken", (tokenEl.value || "").trim());
    alert("Saved.");
  });

  document.getElementById("refresh").addEventListener("click", () => fetchDeliveries({ reset: true }));
  document.getElementById("loadMore").addEventListener("click", () => {
    if (!nextCursor) return alert("No more.");
    fetchDeliveries({ reset: false });
  });

  if (saved) fetchDeliveries({ reset: true });
</script>

</body>
</html>`);
});


// --- Start server + worker (start-once + graceful shutdown) ---

let stopWebhookWorker: null | (() => void) = null;

async function startWorkersOnce() {
  if (stopWebhookWorker) return;

  // DB ping before starting worker (prevents noisy loop on boot)
  await prisma.$queryRaw`SELECT 1`;

  stopWebhookWorker = startWebhookWorker();
  webhookWorkerStartedAt = new Date();

  console.log("[webhooks] worker started at", webhookWorkerStartedAt.toISOString());
}

// Worker moved to dedicated Railway worker service
// startWorkersOnce().catch((e) => {
//   console.error("[startup] failed to start workers:", e);
// });

const server = app.listen(PORT, () => {
  console.log(`GoGetter API listening on port ${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}`);

  try {

    // stop accepting new HTTP requests
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("[shutdown] http server closed");

    // disconnect prisma cleanly (prevents hanging in prod)
    try {
      const { prisma } = await import("./prisma"); // adjust path if server.ts is in src/
      await prisma.$disconnect();
      console.log("[shutdown] prisma disconnected");
    } catch (e) {
      // If your server.ts imports prisma from "../prisma" etc, just import directly there instead
      console.log("[shutdown] prisma disconnect skipped/failed:", e);
    }
  } catch (e) {
    console.error("[shutdown] error:", e);
  } finally {
    process.exit(0);
  }
}

// Common termination signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Helpful in some hosting environments
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  shutdown("unhandledRejection");
});
