export type StripeWebhookIdempotencyDeps = {
  prisma: {
    stripeWebhookEvent: {
      create: (args: any) => Promise<any>;
    };
  };
};

export async function recordStripeWebhookEventOnce(args: {
  stripeEventId: string;
  type: string;
  paymentIntentId?: string | null;
  payloadHash?: string | null;
  deps: StripeWebhookIdempotencyDeps;
}): Promise<{ alreadyProcessed: boolean }> {
  const stripeEventId = String(args.stripeEventId ?? "").trim();
  if (!stripeEventId) {
    // If the event id is missing, we cannot de-dupe at the event layer.
    return { alreadyProcessed: false };
  }

  try {
    await args.deps.prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId,
        type: String(args.type ?? "unknown"),
        paymentIntentId: args.paymentIntentId ? String(args.paymentIntentId) : null,
        payloadHash: args.payloadHash ? String(args.payloadHash) : null,
      },
    });
    return { alreadyProcessed: false };
  } catch (e: any) {
    // Prisma unique constraint violation
    if (String(e?.code ?? "") === "P2002") {
      return { alreadyProcessed: true };
    }
    throw e;
  }
}
