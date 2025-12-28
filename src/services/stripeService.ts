import Stripe from "stripe";
import { env } from "../config/env";
import { prisma } from "../prisma";

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  // Do not pin to a nonstandard API version string.
  // Leaving this unset uses the SDK/account default and avoids runtime failures.
});

export async function createPaymentIntent(userId: number, tier: "BASIC" | "PRO") {
  const prices = {
    BASIC: 600, // $6.00 in cents
    PRO: 1200,  // $12.00 in cents
  };

  const amount = prices[tier];

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    metadata: {
      userId: String(userId),
      tier,
      userEmail: user.email,
    },
    description: `${tier} Subscription for ${user.name}`,
  });

  // Store the payment intent in database
  await prisma.stripePayment.create({
    data: {
      userId,
      tier,
      amount,
      currency: "usd",
      stripePaymentIntentId: paymentIntent.id,
      status: "PENDING",
    },
  });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

export async function handlePaymentIntentSucceeded(
  paymentIntentId: string
) {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  const stripePayment = await prisma.stripePayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { user: true, subscription: true },
  });

  if (!stripePayment) {
    throw new Error("Payment record not found");
  }

  // Update payment status
  await prisma.stripePayment.update({
    where: { id: stripePayment.id },
    data: { status: "SUCCEEDED" },
  });

  // Update or create subscription
  const subscription = await prisma.subscription.upsert({
    where: { userId: stripePayment.userId },
    update: {
      tier: stripePayment.tier,
      renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    },
    create: {
      userId: stripePayment.userId,
      tier: stripePayment.tier,
      renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return { subscription, stripePayment };
}

export async function handlePaymentIntentFailed(paymentIntentId: string) {
  const stripePayment = await prisma.stripePayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });

  if (!stripePayment) {
    throw new Error("Payment record not found");
  }

  await prisma.stripePayment.update({
    where: { id: stripePayment.id },
    data: { status: "FAILED" },
  });
}

export async function recordAdRevenue(
  userId: number,
  adFormat: "banner" | "interstitial",
  revenue: number
) {
  return prisma.adRevenue.create({
    data: {
      userId,
      adFormat,
      platform: "admob",
      revenue: String(revenue),
      currency: "usd",
      impressions: 1,
      date: new Date(),
    },
  });
}

export async function getUserAdRevenue(userId: number, days: number = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const revenue = await prisma.adRevenue.aggregate({
    where: {
      userId,
      date: { gte: startDate },
    },
    _sum: { revenue: true },
    _count: true,
  });

  return {
    totalRevenue: revenue._sum.revenue || 0,
    impressions: revenue._count,
    period: `${days} days`,
  };
}

export async function createPayout(
  userId: number,
  type: "subscription" | "ad_revenue",
  amount: number,
  description?: string
) {
  const payout = await prisma.payout.create({
    data: {
      userId,
      type,
      amount: String(amount),
      currency: "usd",
      status: "pending",
      description,
    },
  });

  return payout;
}

export async function processPayout(payoutId: string) {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { user: true },
  });

  if (!payout) {
    throw new Error("Payout not found");
  }

  // Get user's Stripe account info (you'd need to store this separately)
  // For now, we'll just mark it as processing
  try {
    // Optional: Create a Stripe payout to connected account
    // This assumes you have a Stripe Connect account setup
    // const stripePayout = await stripe.payouts.create({
    //   amount: Math.round(Number(payout.amount) * 100), // Convert to cents
    //   currency: "usd",
    //   description: payout.description,
    // });

    const updated = await prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: "processing",
        // stripePayoutId: stripePayout.id,
        paidAt: new Date(),
      },
    });

    return updated;
  } catch (error) {
    throw error;
  }
}
