-- AlterTable
ALTER TABLE "JobMatchNotification" ADD COLUMN     "digestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "jobMatchDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jobMatchDigestIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "jobMatchDigestLastSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobMatchNotification_providerId_digestedAt_createdAt_idx" ON "JobMatchNotification"("providerId", "digestedAt", "createdAt");
