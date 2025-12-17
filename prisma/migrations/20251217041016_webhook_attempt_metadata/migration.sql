-- AlterTable
ALTER TABLE "WebhookDeliveryAttempt" ADD COLUMN     "endpointId" INTEGER,
ADD COLUMN     "endpointUrl" TEXT,
ADD COLUMN     "event" TEXT;

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_deliveryId_createdAt_idx" ON "WebhookDeliveryAttempt"("deliveryId", "createdAt");
