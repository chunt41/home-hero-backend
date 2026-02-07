import test from "node:test";
import assert from "node:assert/strict";

import { createConfirmPaymentHandler } from "./payments";

test("/payments/confirm handler is read-only (does not update subscription tier)", async () => {
  const stripeClient: any = {
    paymentIntents: {
      async retrieve(id: string) {
        assert.equal(id, "pi_1");
        return {
          id,
          status: "succeeded",
          metadata: { userId: "123" },
        };
      },
    },
  };

  let subscriptionFindCalls = 0;
  const prismaClient: any = {
    subscription: {
      async findUnique(_args: any) {
        subscriptionFindCalls += 1;
        return { userId: 123, tier: "FREE" };
      },
      async upsert() {
        throw new Error("subscription.upsert should not be called from confirm");
      },
      async update() {
        throw new Error("subscription.update should not be called from confirm");
      },
    },
    stripePayment: {
      async updateMany() {
        throw new Error("stripePayment.updateMany should not be called from confirm");
      },
    },
    providerProfile: {
      async upsert() {
        throw new Error("providerProfile.upsert should not be called from confirm");
      },
      async update() {
        throw new Error("providerProfile.update should not be called from confirm");
      },
    },
  };

  const handlerNoDb = createConfirmPaymentHandler({
    stripeClient,
    prismaClient,
    logSecurityEventImpl: async () => {},
  });

  const req: any = {
    user: { userId: 123 },
    validated: { body: { paymentIntentId: "pi_1" } },
    headers: {},
  };

  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };

  // Silence expected console output if any.
  const oldError = console.error;
  console.error = () => {};
  await handlerNoDb(req, res);
  console.error = oldError;

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.success, true);
  assert.equal(res.body?.subscription?.tier, "FREE");
  assert.equal(subscriptionFindCalls, 1);
});
