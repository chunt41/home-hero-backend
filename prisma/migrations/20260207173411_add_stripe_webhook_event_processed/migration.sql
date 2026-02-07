-- AlterTable
ALTER TABLE "BackgroundJob" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PushToken" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "StripeWebhookEventProcessed" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeWebhookEventProcessed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeWebhookEventProcessed_stripeEventId_key" ON "StripeWebhookEventProcessed"("stripeEventId");

-- CreateIndex
CREATE INDEX "StripeWebhookEventProcessed_eventType_idx" ON "StripeWebhookEventProcessed"("eventType");

-- CreateIndex
CREATE INDEX "StripeWebhookEventProcessed_createdAt_idx" ON "StripeWebhookEventProcessed"("createdAt");

-- CreateIndex
CREATE INDEX "ProviderEntitlement_providerId_idx" ON "ProviderEntitlement"("providerId");
