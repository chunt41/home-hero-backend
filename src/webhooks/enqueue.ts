// src/webhooks/enqueue.ts
import { WebhookDeliveryStatus } from "@prisma/client";
import { prisma } from "../prisma";


export async function enqueueWebhookEvent(input: { eventType: string; payload: any }) {
  const { eventType, payload } = input;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { enabled: true, events: { has: eventType } },
    select: { id: true },
  });

  if (endpoints.length === 0) return;

  await prisma.webhookDelivery.createMany({
    data: endpoints.map((e) => ({
      endpointId: e.id,
      event: eventType,
      payload,
      status: WebhookDeliveryStatus.PENDING,
      attempts: 0,
      nextAttempt: new Date(),
    })),
  });
}
