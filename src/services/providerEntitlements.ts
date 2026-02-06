import type { Prisma, SubscriptionTier } from "@prisma/client";

export type ProviderLeadEntitlements = {
  tier: SubscriptionTier;
  usageMonthKey: string;
  baseLeadLimitThisMonth: number;
  extraLeadCreditsThisMonth: number;
  leadsUsedThisMonth: number;
  addonLeadCredits: number;
  remainingLeadsThisMonth: number;
};

export function getUsageMonthKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function getBaseLeadLimitForTier(tier: SubscriptionTier): number {
  switch (tier) {
    case "FREE":
      return 5;
    case "BASIC":
      return 100;
    case "PRO":
      // Keep this effectively unlimited while still being a number.
      return 1_000_000;
    default: {
      const _exhaustive: never = tier;
      return _exhaustive;
    }
  }
}

export async function ensureSubscriptionUsageIsCurrent(
  tx: Prisma.TransactionClient,
  userId: number,
  now: Date = new Date()
) {
  const monthKey = getUsageMonthKey(now);

  const sub = await tx.subscription.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      tier: "FREE",
      usageMonthKey: monthKey,
      leadsUsedThisMonth: 0,
      extraLeadCreditsThisMonth: 0,
    },
  });

  if (sub.usageMonthKey !== monthKey) {
    return tx.subscription.update({
      where: { id: sub.id },
      data: {
        usageMonthKey: monthKey,
        leadsUsedThisMonth: 0,
        extraLeadCreditsThisMonth: 0,
      },
    });
  }

  return sub;
}

export function getLeadEntitlementsFromSubscription(input: {
  tier: SubscriptionTier;
  usageMonthKey: string;
  leadsUsedThisMonth: number;
  extraLeadCreditsThisMonth: number;
}): ProviderLeadEntitlements {
  const baseLeadLimitThisMonth = getBaseLeadLimitForTier(input.tier);
  const totalLimit = baseLeadLimitThisMonth + Math.max(0, input.extraLeadCreditsThisMonth);
  const remainingLeadsThisMonth = Math.max(0, totalLimit - Math.max(0, input.leadsUsedThisMonth));

  return {
    tier: input.tier,
    usageMonthKey: input.usageMonthKey,
    baseLeadLimitThisMonth,
    extraLeadCreditsThisMonth: input.extraLeadCreditsThisMonth,
    leadsUsedThisMonth: input.leadsUsedThisMonth,
    addonLeadCredits: 0,
    remainingLeadsThisMonth,
  };
}

export async function consumeLeadIfAvailable(
  tx: Prisma.TransactionClient,
  userId: number,
  now: Date = new Date()
): Promise<{ ok: true; entitlements: ProviderLeadEntitlements } | { ok: false; entitlements: ProviderLeadEntitlements }> {
  const sub = await ensureSubscriptionUsageIsCurrent(tx, userId, now);
  const baseEntitlements = getLeadEntitlementsFromSubscription({
    tier: sub.tier,
    usageMonthKey: sub.usageMonthKey,
    leadsUsedThisMonth: sub.leadsUsedThisMonth,
    extraLeadCreditsThisMonth: sub.extraLeadCreditsThisMonth,
  });

  // Add-on lead credits (persist across months)
  const addon = await tx.providerEntitlement.upsert({
    where: { providerId: userId },
    update: {},
    create: {
      providerId: userId,
      verificationBadge: false,
      featuredZipCodes: [],
      leadCredits: 0,
    },
    select: { id: true, leadCredits: true },
  });

  const entitlements: ProviderLeadEntitlements = {
    ...baseEntitlements,
    addonLeadCredits: addon.leadCredits,
    remainingLeadsThisMonth: baseEntitlements.remainingLeadsThisMonth + Math.max(0, addon.leadCredits),
  };

  if (entitlements.remainingLeadsThisMonth <= 0) {
    return { ok: false, entitlements };
  }

  // Prefer consuming monthly subscription capacity first.
  if (baseEntitlements.remainingLeadsThisMonth > 0) {
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        leadsUsedThisMonth: { increment: 1 },
      },
      select: {
        tier: true,
        usageMonthKey: true,
        leadsUsedThisMonth: true,
        extraLeadCreditsThisMonth: true,
      },
    });

    const updatedBase = getLeadEntitlementsFromSubscription(updated);
    return {
      ok: true,
      entitlements: {
        ...updatedBase,
        addonLeadCredits: addon.leadCredits,
        remainingLeadsThisMonth: updatedBase.remainingLeadsThisMonth + Math.max(0, addon.leadCredits),
      },
    };
  }

  // Otherwise consume an add-on credit.
  if (addon.leadCredits <= 0) {
    return { ok: false, entitlements };
  }

  const updatedAddon = await tx.providerEntitlement.update({
    where: { id: addon.id },
    data: { leadCredits: { decrement: 1 } },
    select: { leadCredits: true },
  });

  return {
    ok: true,
    entitlements: {
      ...baseEntitlements,
      addonLeadCredits: updatedAddon.leadCredits,
      remainingLeadsThisMonth: baseEntitlements.remainingLeadsThisMonth + Math.max(0, updatedAddon.leadCredits),
    },
  };
}
