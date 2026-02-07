import test from "node:test";
import assert from "node:assert/strict";

import { applyPaymentIntentSucceededFromWebhook } from "./stripeService";

test("replayed webhook does not double-apply subscription tier", async () => {
  let upsertCalls = 0;
  const stripePaymentRow: any = {
    id: "sp_1",
    userId: 42,
    tier: "PRO",
    kind: "SUBSCRIPTION",
    status: "PENDING",
  };

  const subscriptionRow: any = {
    userId: 42,
    tier: "FREE",
    renewsAt: null,
    usageMonthKey: null,
  };

  const prisma: any = {
    stripePayment: {
      async findUnique(_args: any) {
        return stripePaymentRow;
      },
    },
    subscription: {
      async findUnique(_args: any) {
        return subscriptionRow;
      },
    },
    async $transaction(fn: any) {
      const tx: any = {
        stripePayment: {
          async updateMany(args: any) {
            const shouldUpdate =
              args?.where?.id === stripePaymentRow.id &&
              args?.where?.status?.not === "SUCCEEDED" &&
              stripePaymentRow.status !== "SUCCEEDED";

            if (!shouldUpdate) return { count: 0 };
            stripePaymentRow.status = "SUCCEEDED";
            return { count: 1 };
          },
        },
        subscription: {
          async findUnique(_args: any) {
            return subscriptionRow;
          },
          async upsert(args: any) {
            upsertCalls += 1;
            subscriptionRow.userId = args.where.userId;
            subscriptionRow.tier = args.update.tier;
            subscriptionRow.renewsAt = args.update.renewsAt;
            subscriptionRow.usageMonthKey = args.update.usageMonthKey;
            return { ...subscriptionRow };
          },
        },
      };

      return fn(tx);
    },
  };

  const stripeClient: any = {
    paymentIntents: {
      async retrieve(id: string) {
        assert.equal(id, "pi_sub_1");
        return { id, status: "succeeded", metadata: { kind: "SUBSCRIPTION" } };
      },
    },
  };

  const first = await applyPaymentIntentSucceededFromWebhook("pi_sub_1", {
    prisma,
    stripeClient,
    now: new Date("2026-02-06T00:00:00.000Z"),
  });
  assert.equal(subscriptionRow.tier, "PRO");
  assert.equal(upsertCalls, 1);
  assert.equal((first as any)?.idempotent, false);

  const second = await applyPaymentIntentSucceededFromWebhook("pi_sub_1", {
    prisma,
    stripeClient,
    now: new Date("2026-02-06T00:00:10.000Z"),
  });
  assert.equal(subscriptionRow.tier, "PRO");
  assert.equal(upsertCalls, 1);
  assert.equal((second as any)?.idempotent, true);
});
