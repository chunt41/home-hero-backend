-- AlterEnum
ALTER TYPE "BackgroundJobStatus" ADD VALUE 'DEAD';

-- AlterEnum
ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'DEAD';

-- AlterTable
ALTER TABLE "BackgroundJob" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3);
