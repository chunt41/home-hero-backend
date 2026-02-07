import test from "node:test";
import assert from "node:assert/strict";

import { createStripeWebhookHandler } from "./payments";

test("/payments/webhook is replay-safe by stripe event id", async () => {
  const calls: { applySucceeded: number; processedCreate: number } = {
    applySucceeded: 0,
    processedCreate: 0,
  };

  const prismaClient: any = {
    stripeWebhookEvent: {
      async create(_args: any) {
        calls.processedCreate += 1;
        if (calls.processedCreate >= 2) {
          const err: any = new Error("Unique constraint");
          err.code = "P2002";
          throw err;
        }
        return { id: "evt_row" };
      },
    },
  };

  const stripeWebhooks: any = {
    constructEvent(_body: any, _sig: string, _secret: string) {
      return {
        id: "evt_1",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_1",
            metadata: { kind: "SUBSCRIPTION" },
          },
        },
      };
    },
  };

  const applySucceeded = async (_paymentIntentId: string) => {
    calls.applySucceeded += 1;
    return { idempotent: false, subscription: { tier: "PRO" } };
  };

  const handler = createStripeWebhookHandler({
    prismaClient,
    stripeWebhooks,
    applySucceeded: applySucceeded as any,
    applyFailed: async () => {
      throw new Error("applyFailed should not be called");
    },
    logSecurityEventImpl: async () => {},
    webhookSecret: "whsec_test",
  });

  const makeReqRes = () => {
    const req: any = {
      headers: { "stripe-signature": "sig" },
      body: Buffer.from("{}"),
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

    return { req, res };
  };

  const first = makeReqRes();
  await handler(first.req, first.res);
  assert.equal(first.res.statusCode, 200);
  assert.deepEqual(first.res.body, { received: true });

  const second = makeReqRes();
  await handler(second.req, second.res);
  assert.equal(second.res.statusCode, 200);
  assert.deepEqual(second.res.body, { received: true, replay: true });

  assert.equal(calls.applySucceeded, 1);
  assert.equal(calls.processedCreate, 2);
});
