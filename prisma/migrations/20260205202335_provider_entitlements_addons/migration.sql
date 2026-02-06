-- CreateEnum
CREATE TYPE "StripePaymentKind" AS ENUM ('SUBSCRIPTION', 'ADDON');

-- CreateEnum
CREATE TYPE "ProviderAddonType" AS ENUM ('EXTRA_LEADS', 'VERIFICATION_BADGE', 'FEATURED_ZIP_CODES');

-- DropIndex
DROP INDEX "SecurityEvent_actorRole_idx";

-- DropIndex
DROP INDEX "SecurityEvent_targetId_idx";

-- DropIndex
DROP INDEX "SecurityEvent_targetType_idx";

-- AlterTable
ALTER TABLE "JobAttachment" ADD COLUMN     "diskPath" TEXT,
ADD COLUMN     "uploaderUserId" INTEGER;

-- AlterTable
ALTER TABLE "MessageAttachment" ADD COLUMN     "diskPath" TEXT,
ADD COLUMN     "uploaderUserId" INTEGER;

-- AlterTable
ALTER TABLE "ProviderProfile" ADD COLUMN     "featuredZipCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "verificationBadge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StripePayment" ADD COLUMN     "addonQuantity" INTEGER,
ADD COLUMN     "addonType" "ProviderAddonType",
ADD COLUMN     "addonZipCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "kind" "StripePaymentKind" NOT NULL DEFAULT 'SUBSCRIPTION';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "extraLeadCreditsThisMonth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "leadsUsedThisMonth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "usageMonthKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "JobAttachment_jobId_idx" ON "JobAttachment"("jobId");
