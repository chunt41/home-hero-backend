import test from "node:test";
import assert from "node:assert/strict";

import {
  createProviderAddonPaymentIntentV2,
  handleAddonV2PaymentIntentSucceeded,
} from "./addonPurchasesV2";

function makeFakeStripe() {
  const calls: any[] = [];
  return {
    calls,
    paymentIntents: {
      create: async (args: any) => {
        calls.push(args);
        return {
          id: "pi_test_123",
          client_secret: "secret_123",
          amount: args.amount,
          currency: args.currency,
          metadata: args.metadata,
        };
      },
    },
  } as any;
}

function makeFakePrisma() {
  const addonPurchases: any[] = [];
  const entByProviderId = new Map<number, any>();

  const prisma: any = {
    user: {
      findUnique: async ({ where: { id } }: any) => ({ id, name: "Test Provider", email: "p@test.com" }),
    },
    addonPurchase: {
      create: async ({ data, select }: any) => {
        const row = { id: `ap_${addonPurchases.length + 1}`, ...data };
        addonPurchases.push(row);
        return select ? { id: row.id } : row;
      },
      findUnique: async ({ where: { stripePaymentIntentId }, select }: any) => {
        const found = addonPurchases.find((p) => p.stripePaymentIntentId === stripePaymentIntentId) ?? null;
        if (!found) return null;
        if (!select) return found;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = found[k];
        }
        return out;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const p of addonPurchases) {
          const match =
            p.stripePaymentIntentId === where.stripePaymentIntentId &&
            (where.status?.not ? p.status !== where.status.not : true);
          if (match) {
            Object.assign(p, data);
            count++;
          }
        }
        return { count };
      },
    },
    providerEntitlement: {
      upsert: async ({ where: { providerId }, create, select }: any) => {
        const existing = entByProviderId.get(providerId);
        if (!existing) {
          const row = { id: `pe_${providerId}`, ...create };
          entByProviderId.set(providerId, row);
        }
        const row = entByProviderId.get(providerId);
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = row[k];
        }
        return out;
      },
      update: async ({ where, data, select }: any) => {
        const row = Array.from(entByProviderId.values()).find((r) => r.id === where.id);
        if (!row) throw new Error("entitlement not found");
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as any)) {
            row[k] = (row[k] ?? 0) + (v as any).increment;
          } else if (v && typeof v === "object" && "decrement" in (v as any)) {
            row[k] = (row[k] ?? 0) - (v as any).decrement;
          } else {
            row[k] = v;
          }
        }
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if ((select as any)[k]) out[k] = row[k];
        }
        return out;
      },
    },
    $transaction: async (fn: any) => fn(prisma),

    // test helpers
    __addonPurchases: addonPurchases,
    __entByProviderId: entByProviderId,
  };

  return prisma;
}

test("createProviderAddonPaymentIntentV2 creates PI + AddonPurchase", async () => {
  const stripe = makeFakeStripe();
  const prisma = makeFakePrisma();

  const res = await createProviderAddonPaymentIntentV2({
    providerId: 42,
    input: { addonType: "LEAD_PACK", packSize: 10 },
    deps: { stripe, prisma },
  });

  assert.equal(res.clientSecret, "secret_123");
  assert.equal(res.paymentIntentId, "pi_test_123");
  assert.equal(prisma.__addonPurchases.length, 1);
  assert.equal(prisma.__addonPurchases[0].status, "PENDING");
  assert.equal(stripe.calls[0].metadata.kind, "ADDON_V2");
});

test("handleAddonV2PaymentIntentSucceeded grants lead credits idempotently", async () => {
  const prisma = makeFakePrisma();

  // seed purchase row to simulate create endpoint
  await prisma.addonPurchase.create({
    data: {
      providerId: 7,
      addonType: "LEAD_PACK",
      amountCents: 500,
      currency: "usd",
      stripePaymentIntentId: "pi_1",
      status: "PENDING",
      metadataJson: {},
    },
    select: { id: true },
  });

  const paymentIntent: any = {
    id: "pi_1",
    amount: 500,
    currency: "usd",
    metadata: {
      kind: "ADDON_V2",
      providerId: "7",
      addonType: "LEAD_PACK",
      addonPackSize: "10",
      addonZipCodes: "",
    },
  };

  const first = await handleAddonV2PaymentIntentSucceeded({ paymentIntent, deps: { prisma } });
  assert.ok(first);
  assert.equal(first?.granted, true);

  const ent = prisma.__entByProviderId.get(7);
  assert.equal(ent.leadCredits, 10);

  const second = await handleAddonV2PaymentIntentSucceeded({ paymentIntent, deps: { prisma } });
  assert.ok(second);
  assert.equal(second?.granted, false);

  const ent2 = prisma.__entByProviderId.get(7);
  assert.equal(ent2.leadCredits, 10);
});

test("handleAddonV2PaymentIntentSucceeded grants verification badge", async () => {
  const prisma = makeFakePrisma();

  await prisma.addonPurchase.create({
    data: {
      providerId: 9,
      addonType: "VERIFICATION_BADGE",
      amountCents: 1000,
      currency: "usd",
      stripePaymentIntentId: "pi_badge",
      status: "PENDING",
      metadataJson: {},
    },
    select: { id: true },
  });

  const paymentIntent: any = {
    id: "pi_badge",
    amount: 1000,
    currency: "usd",
    metadata: {
      kind: "ADDON_V2",
      providerId: "9",
      addonType: "VERIFICATION_BADGE",
      addonPackSize: "",
      addonZipCodes: "",
    },
  };

  const r = await handleAddonV2PaymentIntentSucceeded({ paymentIntent, deps: { prisma } });
  assert.ok(r);

  const ent = prisma.__entByProviderId.get(9);
  assert.equal(ent.verificationBadge, true);
});

test("handleAddonV2PaymentIntentSucceeded merges featured zip codes", async () => {
  const prisma = makeFakePrisma();

  await prisma.addonPurchase.create({
    data: {
      providerId: 11,
      addonType: "FEATURED_ZIP",
      amountCents: 200,
      currency: "usd",
      stripePaymentIntentId: "pi_zip",
      status: "PENDING",
      metadataJson: {},
    },
    select: { id: true },
  });

  // seed existing
  prisma.__entByProviderId.set(11, {
    id: "pe_11",
    providerId: 11,
    verificationBadge: false,
    featuredZipCodes: ["90210"],
    leadCredits: 0,
  });

  const paymentIntent: any = {
    id: "pi_zip",
    amount: 200,
    currency: "usd",
    metadata: {
      kind: "ADDON_V2",
      providerId: "11",
      addonType: "FEATURED_ZIP",
      addonPackSize: "",
      addonZipCodes: "90210,94103",
    },
  };

  const r = await handleAddonV2PaymentIntentSucceeded({ paymentIntent, deps: { prisma } });
  assert.ok(r);

  const ent = prisma.__entByProviderId.get(11);
  assert.deepEqual(ent.featuredZipCodes.sort(), ["90210", "94103"].sort());
});
