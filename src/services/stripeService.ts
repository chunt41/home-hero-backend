import Stripe from "stripe";
import { env } from "../config/env";
import { prisma } from "../prisma";
import { ensureSubscriptionUsageIsCurrent, getUsageMonthKey } from "./providerEntitlements";
import {
  handleAddonV2PaymentIntentFailed,
  handleAddonV2PaymentIntentSucceeded,
} from "./addonPurchasesV2";

export function validateStripeStartupOrThrow(): void {
  if ((process.env.NODE_ENV ?? "development") !== "production") return;

  // Secret key is already required by env.ts; keep this check about webhook safety.
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec || !whsec.trim()) {
    throw new Error("Missing required env var: STRIPE_WEBHOOK_SECRET");
  }
}

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  // Do not pin to a nonstandard API version string.
  // Leaving this unset uses the SDK/account default and avoids runtime failures.
});

type StripeClientLike = {
  paymentIntents: {
    retrieve: (id: string) => Promise<any>;
  };
};

type StripeServiceDeps = {
  prisma?: any;
  stripeClient?: StripeClientLike;
  now?: Date;
};

function mapStripePaymentIntentStatus(status: string | null | undefined): "PENDING" | "SUCCEEDED" | "FAILED" {
  const s = String(status ?? "");
  if (s === "succeeded") return "SUCCEEDED";
  if (s === "canceled" || s === "requires_payment_method" || s === "requires_action") return "PENDING";
  if (s === "processing" || s === "requires_confirmation" || s === "requires_capture") return "PENDING";
  if (s === "payment_failed") return "FAILED";
  return "PENDING";
}

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
      kind: "SUBSCRIPTION",
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
      kind: "SUBSCRIPTION",
      status: "PENDING",
    },
  });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

export type ProviderAddonPurchaseInput =
  | { type: "EXTRA_LEADS"; quantity: number }
  | { type: "VERIFICATION_BADGE" }
  | { type: "FEATURED_ZIP_CODES"; zipCodes: string[] };

function normalizeZipCodes(zipCodes: string[]): string[] {
  return Array.from(
    new Set(
      zipCodes
        .map((z) => String(z).trim())
        .filter((z) => z.length > 0)
        .map((z) => z.toUpperCase())
    )
  );
}

export async function createAddonPaymentIntent(userId: number, addon: ProviderAddonPurchaseInput) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    select: { tier: true },
  });
  const tier = subscription?.tier ?? "FREE";

  let amountCents: number;
  let description: string;
  let addonType: "EXTRA_LEADS" | "VERIFICATION_BADGE" | "FEATURED_ZIP_CODES";
  let addonQuantity: number | null = null;
  let addonZipCodes: string[] = [];

  switch (addon.type) {
    case "EXTRA_LEADS": {
      addonType = "EXTRA_LEADS";
      const qty = Math.max(1, Math.min(10_000, Math.floor(addon.quantity)));
      addonQuantity = qty;
      // $0.50 per extra lead
      amountCents = qty * 50;
      description = `Extra leads (${qty}) for ${user.name}`;
      break;
    }
    case "VERIFICATION_BADGE": {
      addonType = "VERIFICATION_BADGE";
      amountCents = 1000; // $10.00 one-time
      description = `Verification badge for ${user.name}`;
      break;
    }
    case "FEATURED_ZIP_CODES": {
      addonType = "FEATURED_ZIP_CODES";
      addonZipCodes = normalizeZipCodes(addon.zipCodes);
      const qty = addonZipCodes.length;
      if (qty < 1) throw new Error("At least one zip code is required");
      addonQuantity = qty;
      // $2.00 per zip code
      amountCents = qty * 200;
      description = `Featured zip codes (${qty}) for ${user.name}`;
      break;
    }
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    metadata: {
      userId: String(userId),
      kind: "ADDON",
      addonType,
      addonQuantity: addonQuantity ? String(addonQuantity) : "",
      addonZipCodes: addonZipCodes.join(","),
      userEmail: user.email,
    },
    description,
  });

  await prisma.stripePayment.create({
    data: {
      userId,
      tier,
      amount: amountCents,
      currency: "usd",
      stripePaymentIntentId: paymentIntent.id,
      kind: "ADDON",
      addonType,
      addonQuantity,
      addonZipCodes,
      status: "PENDING",
    },
  });

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Read-only-ish client confirmation hook.
 *
 * This may refresh the local StripePayment status, but MUST NOT grant entitlements or
 * modify subscription tiers. Webhooks are the canonical source of truth for entitlements.
 */
export async function refreshPaymentIntentStatusReadOnly(args: {
  paymentIntentId: string;
  userId: number;
  deps?: StripeServiceDeps;
}): Promise<{ ok: true; status: string; paymentStatus: "PENDING" | "SUCCEEDED" | "FAILED" } | { ok: false; status: string; paymentStatus: "PENDING" | "SUCCEEDED" | "FAILED" }> {
  const { paymentIntentId, userId } = args;
  const prismaClient = args.deps?.prisma ?? prisma;
  const stripeClient = args.deps?.stripeClient ?? (stripe as any as StripeClientLike);

  const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);
  const status = String(paymentIntent?.status ?? "unknown");
  const paymentStatus = mapStripePaymentIntentStatus(status);

  if (paymentIntent?.metadata?.userId && paymentIntent.metadata.userId !== String(userId)) {
    throw new Error("Payment mismatch");
  }

  // Best-effort: update local payment status for UI. Do not modify subscription/entitlements.
  try {
    await prismaClient.stripePayment.updateMany({
      where: { stripePaymentIntentId: paymentIntentId, userId },
      data: { status: paymentStatus },
    });
  } catch {
    // ignore (read-only-ish)
  }

  if (status !== "succeeded") {
    return { ok: false, status, paymentStatus };
  }

  return { ok: true, status, paymentStatus };
}

/**
 * Entitlement/subscription application path.
 *
 * Only Stripe webhooks should call this.
 */
export async function applyPaymentIntentSucceededFromWebhook(
  paymentIntentId: string,
  deps?: StripeServiceDeps
) {
  const prismaClient = deps?.prisma ?? prisma;
  const stripeClient = deps?.stripeClient ?? (stripe as any as StripeClientLike);
  const now = deps?.now ?? new Date();

  const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId);

  // ADDON_V2: new provider entitlement flow (AddonPurchase + ProviderEntitlement)
  if (paymentIntent.metadata?.kind === "ADDON_V2") {
    const result = await handleAddonV2PaymentIntentSucceeded({
      paymentIntent: paymentIntent as any,
      deps: { prisma: prismaClient },
    });

    // Keep return shape compatible with /payments/confirm (mobile expects subscription key).
    const subscription = await prismaClient.subscription.findUnique({
      where: { userId: Number(paymentIntent.metadata?.providerId) },
    });

    return { subscription, addonResult: result };
  }

  const stripePayment = await prismaClient.stripePayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { user: true, subscription: true },
  });

  if (!stripePayment) {
    throw new Error("Payment record not found");
  }

  const monthKey = getUsageMonthKey(now);

  const { subscription, idempotent } = await prismaClient.$transaction(async (tx: any) => {
    // Idempotency guard: only the first success transition should apply entitlements.
    const transitioned = await tx.stripePayment.updateMany({
      where: { id: stripePayment.id, status: { not: "SUCCEEDED" } },
      data: { status: "SUCCEEDED" },
    });

    if (transitioned.count === 0) {
      const existing = await tx.subscription.findUnique({
        where: { userId: stripePayment.userId },
      });
      return { subscription: existing, idempotent: true };
    }

    if (stripePayment.kind === "SUBSCRIPTION") {
      const subscription = await tx.subscription.upsert({
        where: { userId: stripePayment.userId },
        update: {
          tier: stripePayment.tier,
          renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
          usageMonthKey: monthKey,
        },
        create: {
          userId: stripePayment.userId,
          tier: stripePayment.tier,
          renewsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          usageMonthKey: monthKey,
        },
      });

      return { subscription, idempotent: false };
    }

    // ADDON: apply entitlements/add-ons
    const sub = await ensureSubscriptionUsageIsCurrent(tx, stripePayment.userId, now);

    if (stripePayment.addonType === "EXTRA_LEADS") {
      const qty = Math.max(0, stripePayment.addonQuantity ?? 0);
      await tx.subscription.update({
        where: { id: sub.id },
        data: { extraLeadCreditsThisMonth: { increment: qty } },
      });
    } else if (stripePayment.addonType === "VERIFICATION_BADGE") {
      await tx.providerProfile.upsert({
        where: { providerId: stripePayment.userId },
        update: { verificationBadge: true },
        create: { providerId: stripePayment.userId, verificationBadge: true },
      });
    } else if (stripePayment.addonType === "FEATURED_ZIP_CODES") {
      const profile = await tx.providerProfile.upsert({
        where: { providerId: stripePayment.userId },
        update: {},
        create: { providerId: stripePayment.userId },
      });

      const existing = Array.isArray(profile.featuredZipCodes)
        ? profile.featuredZipCodes
        : [];
      const merged = Array.from(new Set([...existing, ...(stripePayment.addonZipCodes ?? [])]));

      await tx.providerProfile.update({
        where: { id: profile.id },
        data: { featuredZipCodes: merged },
      });
    }

    const subscription = await tx.subscription.findUnique({
      where: { userId: stripePayment.userId },
    });

    if (!subscription) {
      throw new Error("Subscription not found after addon applied");
    }

    return { subscription, idempotent: false };
  });

  return { subscription, stripePayment, idempotent };
}

export async function applyPaymentIntentFailedFromWebhook(paymentIntentId: string, deps?: StripeServiceDeps) {
  const prismaClient = deps?.prisma ?? prisma;
  const stripeClient = deps?.stripeClient ?? (stripe as any as StripeClientLike);

  // Best-effort: if this is an ADDON_V2 payment intent, mark it failed.
  try {
    const pi = await stripeClient.paymentIntents.retrieve(paymentIntentId);
    if (pi.metadata?.kind === "ADDON_V2") {
      await handleAddonV2PaymentIntentFailed({
        paymentIntent: pi as any,
        deps: { prisma: prismaClient },
      });
      return;
    }
  } catch {
    // ignore
  }

  const stripePayment = await prismaClient.stripePayment.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  });

  if (!stripePayment) {
    throw new Error("Payment record not found");
  }

  await prismaClient.stripePayment.update({
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
