import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireAttestation } from "../middleware/requireAttestation";
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

const router = createAsyncRouter(express);

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
  requireAttestation,
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
  requireAttestation,
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
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];

      if (!sig) {
        await logSecurityEvent(req, "payment.webhook_failed", {
          reason: "missing_signature",
        });
        return res.status(400).json({ error: "Missing stripe signature" });
      }

      if (!env.STRIPE_WEBHOOK_SECRET) {
        await logSecurityEvent(req, "payment.webhook_failed", {
          reason: "webhook_secret_not_configured",
        });
        return res.status(500).json({
          error:
            "Stripe webhook secret not configured (set STRIPE_WEBHOOK_SECRET)",
        });
      }

      const event = stripe.webhooks.constructEvent(
        req.body,
        sig as string,
        env.STRIPE_WEBHOOK_SECRET
      );

      await logSecurityEvent(req, "payment.webhook_received", {
        stripeEventType: event.type,
        stripeEventId: (event as any)?.id ?? null,
      });

      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object as any;
        const r = await applyPaymentIntentSucceededFromWebhook(paymentIntent.id);
        await logSecurityEvent(req, "payment.webhook_processed", {
          stripeEventType: event.type,
          stripeEventId: (event as any)?.id ?? null,
          paymentIntentId: paymentIntent.id,
          idempotent: Boolean((r as any)?.idempotent),
          kind: String(paymentIntent?.metadata?.kind ?? "unknown"),
        });
      } else if (event.type === "payment_intent.payment_failed") {
        const paymentIntent = event.data.object as any;
        await applyPaymentIntentFailedFromWebhook(paymentIntent.id);
        await logSecurityEvent(req, "payment.webhook_processed", {
          stripeEventType: event.type,
          stripeEventId: (event as any)?.id ?? null,
          paymentIntentId: paymentIntent.id,
          kind: String(paymentIntent?.metadata?.kind ?? "unknown"),
        });
      }

      res.json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error);
      await logSecurityEvent(req, "payment.webhook_failed", {
        reason: "exception",
        message: String(error?.message ?? error),
      });
      res.status(400).json({ error: error.message });
    }
  }
);

/**
 * GET /payments/subscription/:userId
 * Get user's subscription status and payment history
 */
router.get("/subscription/:userId", authMiddleware, requireVerifiedEmail, requireAttestation, async (req, res) => {
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
