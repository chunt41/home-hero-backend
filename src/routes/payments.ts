import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  createPaymentIntent,
  applyPaymentIntentSucceededFromWebhook,
  applyPaymentIntentFailedFromWebhook,
  stripe,
} from "../services/stripeService";
import { env } from "../config/env";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { logSecurityEvent } from "../services/securityEventLogger";
import { createAsyncRouter } from "../middleware/asyncWrap";
import { recordStripeWebhookEventOnce } from "../services/billing/stripeWebhookIdempotency";
import crypto from "node:crypto";

const router = createAsyncRouter(express);

export function createStripeWebhookHandler(deps?: {
  prismaClient?: typeof prisma;
  stripeWebhooks?: { constructEvent: (body: any, sig: string, secret: string) => any };
  applySucceeded?: typeof applyPaymentIntentSucceededFromWebhook;
  applyFailed?: typeof applyPaymentIntentFailedFromWebhook;
  logSecurityEventImpl?: typeof logSecurityEvent;
  webhookSecret?: string | undefined;
}) {
  const prismaClient = deps?.prismaClient ?? prisma;
  const stripeWebhooks = deps?.stripeWebhooks ?? stripe.webhooks;
  const applySucceeded = deps?.applySucceeded ?? applyPaymentIntentSucceededFromWebhook;
  const applyFailed = deps?.applyFailed ?? applyPaymentIntentFailedFromWebhook;
  const logSecurityEventImpl = deps?.logSecurityEventImpl ?? logSecurityEvent;
  const webhookSecret = deps?.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET;

  return async (req: any, res: any) => {
    try {
      const sig = req.headers["stripe-signature"];

      if (!sig) {
        await logSecurityEventImpl(req, "payment.webhook_failed", {
          reason: "missing_signature",
        });
        return res.status(400).json({ error: "Missing stripe signature" });
      }

      if (!webhookSecret) {
        await logSecurityEventImpl(req, "payment.webhook_failed", {
          reason: "webhook_secret_not_configured",
        });
        return res.status(500).json({
          error: "Stripe webhook secret not configured (set STRIPE_WEBHOOK_SECRET)",
        });
      }

      const event = stripeWebhooks.constructEvent(req.body, sig as string, webhookSecret);

      const stripeEventId = (event as any)?.id ? String((event as any).id) : null;

      await logSecurityEventImpl(req, "payment.webhook_received", {
        stripeEventType: event.type,
        stripeEventId,
      });

      // DB-level replay protection by Stripe event id.
      if (stripeEventId) {
        const payloadHash = Buffer.isBuffer(req.body)
          ? crypto.createHash("sha256").update(req.body).digest("hex")
          : null;

        const { alreadyProcessed } = await recordStripeWebhookEventOnce({
          stripeEventId,
          type: String(event.type ?? "unknown"),
          paymentIntentId: (event.data?.object as any)?.id ?? null,
          payloadHash,
          deps: { prisma: prismaClient as any },
        });

        if (alreadyProcessed) {
          await logSecurityEventImpl(req, "payment.webhook_replayed", {
            stripeEventType: event.type,
            stripeEventId,
          });
          return res.json({ received: true, replay: true });
        }
      }

      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object as any;
        const r: any = await applySucceeded(paymentIntent.id);

        const kind = String(paymentIntent?.metadata?.kind ?? "unknown");
        const idempotent = Boolean(r?.idempotent);
        const addonGranted = Boolean(r?.addonResult?.granted);
        const granted = !idempotent || addonGranted;

        if (granted) {
          await logSecurityEventImpl(req, "billing.webhook_grant_applied", {
            targetType: "STRIPE",
            targetId: paymentIntent.id,
            stripeEventType: event.type,
            stripeEventId,
            paymentIntentId: paymentIntent.id,
            kind,
            idempotent,
            tier: r?.subscription?.tier ?? r?.stripePayment?.tier ?? null,
            addonType: r?.stripePayment?.addonType ?? paymentIntent?.metadata?.addonType ?? null,
            providerId: r?.addonResult?.providerId ?? null,
          });
        }

        await logSecurityEventImpl(req, "payment.webhook_processed", {
          stripeEventType: event.type,
          stripeEventId,
          paymentIntentId: paymentIntent.id,
          idempotent,
          kind,
        });
      } else if (event.type === "payment_intent.payment_failed") {
        const paymentIntent = event.data.object as any;
        await applyFailed(paymentIntent.id);
        await logSecurityEventImpl(req, "payment.webhook_processed", {
          stripeEventType: event.type,
          stripeEventId,
          paymentIntentId: paymentIntent.id,
          kind: String(paymentIntent?.metadata?.kind ?? "unknown"),
        });
      }

      return res.json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error);
      await logSecurityEventImpl(req, "payment.webhook_failed", {
        reason: "exception",
        message: String(error?.message ?? error),
      });
      return res.status(400).json({ error: error.message });
    }
  };
}

export function createConfirmPaymentHandler(deps?: {
  stripeClient?: { paymentIntents: { retrieve: (id: string) => Promise<any> } };
  prismaClient?: typeof prisma;
  logSecurityEventImpl?: typeof logSecurityEvent;
}) {
  const stripeClient = deps?.stripeClient ?? stripe;
  const prismaClient = deps?.prismaClient ?? prisma;
  const logSecurityEventImpl = deps?.logSecurityEventImpl ?? logSecurityEvent;

  return async (req: any, res: any) => {
    try {
      const { paymentIntentId } = (req as any).validated.body as { paymentIntentId: string };
      const userId = req.user!.userId;

      // Verify the payment intent
      const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== "succeeded") {
        await logSecurityEventImpl(req, "payment.confirm_failed", {
          targetType: "USER",
          targetId: userId,
          paymentIntentId,
          reason: "not_succeeded",
          status: paymentIntent.status,
        });
        return res.status(400).json({
          error: "Payment not completed",
          status: paymentIntent.status,
        });
      }

      // Check that the payment belongs to this user
      if (paymentIntent.metadata?.userId !== String(userId)) {
        await logSecurityEventImpl(req, "payment.confirm_failed", {
          targetType: "USER",
          targetId: userId,
          paymentIntentId,
          reason: "payment_mismatch",
        });
        return res.status(403).json({ error: "Payment mismatch" });
      }

      // Read-only: do NOT grant entitlements or update subscription tier.
      const subscription = await prismaClient.subscription.findUnique({ where: { userId } });

      await logSecurityEventImpl(req, "payment.confirm_succeeded", {
        targetType: "USER",
        targetId: userId,
        paymentIntentId,
        note: "confirm_is_read_only; entitlements_applied_by_webhook",
        subscriptionTier: (subscription as any)?.tier ?? null,
      });

      return res.json({
        success: true,
        subscription,
        note: "Entitlements are applied via Stripe webhooks.",
      });
    } catch (error: any) {
      console.error("Payment confirmation error:", error);
      return res.status(500).json({ error: error.message });
    }
  };
}

const createIntentSchema = {
  body: z.object({
    tier: z.enum(["BASIC", "PRO"]),
  }),
};

const confirmPaymentSchema = {
  body: z.object({
    paymentIntentId: z.string().trim().min(1, "paymentIntentId is required"),
  }),
};

/**
 * GET /payments/health
 * Admin-only sanity check to confirm Stripe is configured in the running environment.
 * - Does not expose secrets.
 * - Performs a lightweight Stripe API call to validate STRIPE_SECRET_KEY.
 */
router.get("/health", authMiddleware, requireAdmin, async (_req, res) => {
  const hasSecretKey = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.trim());
  const hasWebhookSecret = Boolean(env.STRIPE_WEBHOOK_SECRET && env.STRIPE_WEBHOOK_SECRET.trim());

  let stripeOk = false;
  let stripeAccountId: string | null = null;
  let stripeMode: "live" | "test" | "unknown" = "unknown";

  try {
    const acct = await stripe.accounts.retrieve();
    stripeOk = true;
    stripeAccountId = (acct as any)?.id ?? null;
    const key = env.STRIPE_SECRET_KEY ?? "";
    if (key.startsWith("sk_live_")) stripeMode = "live";
    else if (key.startsWith("sk_test_")) stripeMode = "test";
  } catch (e: any) {
    stripeOk = false;
    stripeAccountId = null;
  }

  return res.json({
    ok: stripeOk && hasSecretKey,
    stripeOk,
    stripeAccountId,
    stripeMode,
    hasSecretKey,
    hasWebhookSecret,
    webhookConfigured: hasWebhookSecret,
  });
});

/**
 * POST /payments/create-intent
 * Create a Stripe payment intent for subscription upgrade
 */
router.post(
  "/create-intent",
  authMiddleware,
  requireVerifiedEmail,
  validate(createIntentSchema),
  async (req, res) => {
  try {
    const { tier } = (req as any).validated.body as { tier: z.infer<typeof createIntentSchema.body.shape.tier> };
    const userId = req.user!.userId;

    const { clientSecret, paymentIntentId } = await createPaymentIntent(userId, tier);

    await logSecurityEvent(req, "payment.create_intent", {
      targetType: "USER",
      targetId: userId,
      tier,
      paymentIntentId,
    });

    res.json({
      clientSecret,
      paymentIntentId,
    });
  } catch (error: any) {
    console.error("Payment intent error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /payments/confirm
 * Confirm payment (read-only)
 *
 * IMPORTANT: This endpoint must never grant entitlements or update subscription tiers.
 * Stripe webhooks are the canonical source of truth for applying entitlements.
 */
router.post(
  "/confirm",
  authMiddleware,
  requireVerifiedEmail,
  validate(confirmPaymentSchema),
  createConfirmPaymentHandler()
);

/**
 * POST /payments/webhook
 * Handle Stripe webhooks
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  validate({}),
  createStripeWebhookHandler()
);

/**
 * GET /payments/subscription/:userId
 * Get user's subscription status and payment history
 */
router.get("/subscription/:userId", authMiddleware, requireVerifiedEmail, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestUserId = req.user!.userId;

    // Users can only view their own subscription unless they're admin
    if (parseInt(userId) !== requestUserId && req.user!.role !== "ADMIN") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const subscription = await prisma.subscription.findUnique({
      where: { userId: parseInt(userId) },
      include: {
        payments: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    const stripePayments = await prisma.stripePayment.findMany({
      where: { userId: parseInt(userId) },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    res.json({
      subscription,
      recentPayments: stripePayments,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
