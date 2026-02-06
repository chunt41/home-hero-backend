import type Stripe from "stripe";
import type { Prisma } from "@prisma/client";

export type AddonTypeV2 = "VERIFICATION_BADGE" | "FEATURED_ZIP" | "LEAD_PACK";

export type ProviderAddonPurchaseRequestV2 =
  | { addonType: "VERIFICATION_BADGE" }
  | { addonType: "FEATURED_ZIP"; zipCode: string }
  | { addonType: "LEAD_PACK"; packSize: number };

export type LegacyProviderAddonPurchaseRequest =
  | { type: "EXTRA_LEADS"; quantity: number }
  | { type: "VERIFICATION_BADGE" }
  | { type: "FEATURED_ZIP_CODES"; zipCodes: string[] };

export type NormalizedAddonParams =
  | { addonType: "VERIFICATION_BADGE"; zipCodes: string[]; packSize: null }
  | { addonType: "FEATURED_ZIP"; zipCodes: string[]; packSize: null }
  | { addonType: "LEAD_PACK"; zipCodes: string[]; packSize: number };

export function normalizeZipCode(zip: string): string {
  return String(zip ?? "")
    .trim()
    .toUpperCase();
}

export function normalizeZipCodes(zips: string[]): string[] {
  const out = new Set<string>();
  for (const z of zips ?? []) {
    const n = normalizeZipCode(z);
    if (n) out.add(n);
  }
  return Array.from(out);
}

export function normalizeAddonRequest(
  input: ProviderAddonPurchaseRequestV2 | LegacyProviderAddonPurchaseRequest
): NormalizedAddonParams {
  if ((input as any)?.addonType) {
    const req = input as ProviderAddonPurchaseRequestV2;
    if (req.addonType === "VERIFICATION_BADGE") {
      return { addonType: "VERIFICATION_BADGE", zipCodes: [], packSize: null };
    }
    if (req.addonType === "FEATURED_ZIP") {
      const zipCodes = normalizeZipCodes([req.zipCode]);
      return { addonType: "FEATURED_ZIP", zipCodes, packSize: null };
    }
    if (req.addonType === "LEAD_PACK") {
      const packSize = Math.max(1, Math.min(100_000, Math.floor(req.packSize)));
      return { addonType: "LEAD_PACK", zipCodes: [], packSize };
    }
  }

  const legacy = input as LegacyProviderAddonPurchaseRequest;
  switch (legacy.type) {
    case "EXTRA_LEADS": {
      const packSize = Math.max(1, Math.min(100_000, Math.floor(legacy.quantity)));
      return { addonType: "LEAD_PACK", zipCodes: [], packSize };
    }
    case "VERIFICATION_BADGE":
      return { addonType: "VERIFICATION_BADGE", zipCodes: [], packSize: null };
    case "FEATURED_ZIP_CODES": {
      const zipCodes = normalizeZipCodes(legacy.zipCodes);
      return { addonType: "FEATURED_ZIP", zipCodes, packSize: null };
    }
  }
}

export function computeAddonAmountCents(params: NormalizedAddonParams): number {
  switch (params.addonType) {
    case "VERIFICATION_BADGE":
      return 1000; // $10
    case "FEATURED_ZIP":
      return Math.max(1, params.zipCodes.length) * 200; // $2 per zip
    case "LEAD_PACK":
      return Math.max(1, params.packSize) * 50; // $0.50 per lead
  }
}

export type CreateAddonPurchaseDeps = {
  stripe: Stripe;
  prisma: {
    addonPurchase: {
      create: (args: any) => Promise<{ id: string }>;
    };
    user: {
      findUnique: (args: any) => Promise<{ id: number; name: string; email: string } | null>;
    };
  };
};

export async function createProviderAddonPaymentIntentV2(args: {
  providerId: number;
  input: ProviderAddonPurchaseRequestV2 | LegacyProviderAddonPurchaseRequest;
  deps: CreateAddonPurchaseDeps;
}): Promise<{ clientSecret: string; paymentIntentId: string; addonPurchaseId: string }> {
  const { providerId, input, deps } = args;
  const user = await deps.prisma.user.findUnique({ where: { id: providerId } });
  if (!user) throw new Error("User not found");

  const normalized = normalizeAddonRequest(input);
  if (normalized.addonType === "FEATURED_ZIP" && normalized.zipCodes.length < 1) {
    throw new Error("zipCode is required");
  }

  const amountCents = computeAddonAmountCents(normalized);

  const paymentIntent = await deps.stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    metadata: {
      kind: "ADDON_V2",
      providerId: String(providerId),
      addonType: normalized.addonType,
      addonZipCodes: normalized.zipCodes.join(","),
      addonPackSize: normalized.packSize != null ? String(normalized.packSize) : "",
      userEmail: user.email,
    },
    description: `${normalized.addonType} add-on for ${user.name}`,
  });

  const addonPurchase = await deps.prisma.addonPurchase.create({
    data: {
      providerId,
      addonType: normalized.addonType,
      amountCents,
      currency: "usd",
      stripePaymentIntentId: paymentIntent.id,
      status: "PENDING",
      metadataJson: {
        kind: "ADDON_V2",
        providerId,
        addonType: normalized.addonType,
        zipCodes: normalized.zipCodes,
        packSize: normalized.packSize,
      },
    },
    select: { id: true },
  });

  return {
    clientSecret: String(paymentIntent.client_secret ?? ""),
    paymentIntentId: paymentIntent.id,
    addonPurchaseId: addonPurchase.id,
  };
}

export type HandleAddonSucceededDeps = {
  prisma: {
    $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
    addonPurchase: {
      findUnique: (args: any) => Promise<any | null>;
    };
  };
};

function parseAddonSucceededFromPaymentIntent(paymentIntent: Stripe.PaymentIntent): {
  providerId: number;
  addonType: AddonTypeV2;
  zipCodes: string[];
  packSize: number | null;
  amountCents: number;
  currency: string;
} | null {
  const md: any = paymentIntent.metadata ?? {};
  if (String(md.kind ?? "") !== "ADDON_V2") return null;

  const providerId = Number(md.providerId);
  if (!Number.isFinite(providerId) || providerId <= 0) return null;

  const addonType = String(md.addonType ?? "") as AddonTypeV2;
  if (addonType !== "VERIFICATION_BADGE" && addonType !== "FEATURED_ZIP" && addonType !== "LEAD_PACK") {
    return null;
  }

  const zipCodes = normalizeZipCodes(String(md.addonZipCodes ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean));

  const packSizeRaw = String(md.addonPackSize ?? "").trim();
  const packSize = packSizeRaw ? Math.max(1, Math.min(100_000, Math.floor(Number(packSizeRaw)))) : null;

  const amountCents = typeof paymentIntent.amount === "number" ? paymentIntent.amount : 0;
  const currency = String(paymentIntent.currency ?? "usd") || "usd";

  return { providerId, addonType, zipCodes, packSize, amountCents, currency };
}

export async function handleAddonV2PaymentIntentSucceeded(args: {
  paymentIntent: Stripe.PaymentIntent;
  deps: HandleAddonSucceededDeps;
}): Promise<{ kind: "ADDON_V2"; granted: boolean; providerId: number } | null> {
  const { paymentIntent, deps } = args;
  const parsed = parseAddonSucceededFromPaymentIntent(paymentIntent);
  if (!parsed) return null;

  const { providerId, addonType, zipCodes, packSize, amountCents, currency } = parsed;
  const paymentIntentId = paymentIntent.id;

  const result = await deps.prisma.$transaction(async (tx) => {
    // Determine whether we should grant entitlements (idempotent)
    const updated = await tx.addonPurchase.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: { not: "SUCCEEDED" },
      },
      data: { status: "SUCCEEDED" },
    });

    let shouldGrant = updated.count > 0;

    if (!shouldGrant) {
      const existing = await tx.addonPurchase.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: { id: true, status: true },
      });

      if (!existing) {
        await tx.addonPurchase.create({
          data: {
            providerId,
            addonType,
            amountCents,
            currency,
            stripePaymentIntentId: paymentIntentId,
            status: "SUCCEEDED",
            metadataJson: {
              kind: "ADDON_V2",
              providerId,
              addonType,
              zipCodes,
              packSize,
            },
          },
          select: { id: true },
        });
        shouldGrant = true;
      }
    }

    if (!shouldGrant) {
      return { granted: false };
    }

    const ent = await tx.providerEntitlement.upsert({
      where: { providerId },
      update: {},
      create: {
        providerId,
        verificationBadge: false,
        featuredZipCodes: [],
        leadCredits: 0,
      },
      select: { id: true, featuredZipCodes: true },
    });

    if (addonType === "VERIFICATION_BADGE") {
      await tx.providerEntitlement.update({
        where: { id: ent.id },
        data: { verificationBadge: true },
      });
    } else if (addonType === "FEATURED_ZIP") {
      const existing = Array.isArray(ent.featuredZipCodes) ? ent.featuredZipCodes : [];
      const merged = Array.from(new Set([...existing, ...zipCodes]));
      await tx.providerEntitlement.update({
        where: { id: ent.id },
        data: { featuredZipCodes: merged },
      });
    } else if (addonType === "LEAD_PACK") {
      const qty = Math.max(0, packSize ?? 0);
      if (qty > 0) {
        await tx.providerEntitlement.update({
          where: { id: ent.id },
          data: { leadCredits: { increment: qty } },
        });
      }
    }

    return { granted: true };
  });

  return { kind: "ADDON_V2", granted: result.granted, providerId };
}

export async function handleAddonV2PaymentIntentFailed(args: {
  paymentIntent: Stripe.PaymentIntent;
  deps: { prisma: { addonPurchase: { updateMany: (args: any) => Promise<any> } } };
}): Promise<{ kind: "ADDON_V2"; providerId: number } | null> {
  const parsed = parseAddonSucceededFromPaymentIntent(args.paymentIntent);
  if (!parsed) return null;

  const providerId = parsed.providerId;
  await args.deps.prisma.addonPurchase.updateMany({
    where: { stripePaymentIntentId: args.paymentIntent.id, status: { not: "SUCCEEDED" } },
    data: { status: "FAILED" },
  });

  return { kind: "ADDON_V2", providerId };
}
