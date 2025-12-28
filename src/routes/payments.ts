import express from "express";
import { prisma } from "../prisma";
import { authMiddleware } from "../middleware/authMiddleware";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  createPaymentIntent,
  handlePaymentIntentSucceeded,
  handlePaymentIntentFailed,
  stripe,
} from "../services/stripeService";
import { env } from "../config/env";

const router = express.Router();

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
router.post("/create-intent", authMiddleware, async (req, res) => {
  try {
    const { tier } = req.body;
    const userId = req.user!.userId;

    if (!tier || !["BASIC", "PRO"].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier" });
    }

    const { clientSecret, paymentIntentId } = await createPaymentIntent(
      userId,
      tier
    );

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
 * Confirm payment and update subscription
 */
router.post("/confirm", authMiddleware, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const userId = req.user!.userId;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "Payment intent ID required" });
    }

    // Verify the payment intent
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({
        error: "Payment not completed",
        status: paymentIntent.status,
      });
    }

    // Check that the payment belongs to this user
    if (paymentIntent.metadata?.userId !== String(userId)) {
      return res.status(403).json({ error: "Payment mismatch" });
    }

    // Update subscription
    const result = await handlePaymentIntentSucceeded(paymentIntentId);

    res.json({
      success: true,
      subscription: result.subscription,
    });
  } catch (error: any) {
    console.error("Payment confirmation error:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /payments/webhook
 * Handle Stripe webhooks
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const sig = req.headers["stripe-signature"];

      if (!sig) {
        return res.status(400).json({ error: "Missing stripe signature" });
      }

      if (!env.STRIPE_WEBHOOK_SECRET) {
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

      if (event.type === "payment_intent.succeeded") {
        const paymentIntent = event.data.object as any;
        await handlePaymentIntentSucceeded(paymentIntent.id);
      } else if (event.type === "payment_intent.payment_failed") {
        const paymentIntent = event.data.object as any;
        await handlePaymentIntentFailed(paymentIntent.id);
      }

      res.json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error);
      res.status(400).json({ error: error.message });
    }
  }
);

/**
 * GET /payments/subscription/:userId
 * Get user's subscription status and payment history
 */
router.get("/subscription/:userId", authMiddleware, async (req, res) => {
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
