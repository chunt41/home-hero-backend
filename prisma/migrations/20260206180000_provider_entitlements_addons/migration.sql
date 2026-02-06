-- CreateEnum
CREATE TYPE "AddonType" AS ENUM ('VERIFICATION_BADGE', 'FEATURED_ZIP', 'LEAD_PACK');

-- CreateTable
CREATE TABLE "ProviderEntitlement" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "verificationBadge" BOOLEAN NOT NULL DEFAULT false,
    "featuredZipCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "leadCredits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddonPurchase" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "addonType" "AddonType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripePaymentIntentId" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddonPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEntitlement_providerId_key" ON "ProviderEntitlement"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "AddonPurchase_stripePaymentIntentId_key" ON "AddonPurchase"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "AddonPurchase_providerId_idx" ON "AddonPurchase"("providerId");

-- CreateIndex
CREATE INDEX "AddonPurchase_status_idx" ON "AddonPurchase"("status");

-- CreateIndex
CREATE INDEX "AddonPurchase_createdAt_idx" ON "AddonPurchase"("createdAt");

-- AddForeignKey
ALTER TABLE "ProviderEntitlement" ADD CONSTRAINT "ProviderEntitlement_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddonPurchase" ADD CONSTRAINT "AddonPurchase_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
