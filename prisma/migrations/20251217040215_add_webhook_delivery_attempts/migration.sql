-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastStatusCode" INTEGER;

-- CreateTable
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" SERIAL NOT NULL,
    "deliveryId" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "ok" BOOLEAN,
    "statusCode" INTEGER,
    "error" TEXT,
    "responseSnippet" TEXT,
    "retryAfter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_deliveryId_attemptNumber_idx" ON "WebhookDeliveryAttempt"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_startedAt_idx" ON "WebhookDeliveryAttempt"("startedAt");

-- AddForeignKey
ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
