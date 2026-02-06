-- CreateEnum
CREATE TYPE "ProviderVerificationStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProviderVerificationMethod" AS ENUM ('ID', 'BACKGROUND_CHECK');

-- CreateTable
CREATE TABLE "ProviderVerification" (
    "providerId" INTEGER NOT NULL,
    "status" "ProviderVerificationStatus" NOT NULL DEFAULT 'NONE',
    "method" "ProviderVerificationMethod",
    "providerSubmittedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderVerification_pkey" PRIMARY KEY ("providerId")
);

-- CreateTable
CREATE TABLE "ProviderVerificationAttachment" (
    "id" SERIAL NOT NULL,
    "providerId" INTEGER NOT NULL,
    "uploaderUserId" INTEGER NOT NULL,
    "filename" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "diskPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderVerificationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderVerification_status_idx" ON "ProviderVerification"("status");

-- CreateIndex
CREATE INDEX "ProviderVerification_providerSubmittedAt_idx" ON "ProviderVerification"("providerSubmittedAt");

-- CreateIndex
CREATE INDEX "ProviderVerification_verifiedAt_idx" ON "ProviderVerification"("verifiedAt");

-- CreateIndex
CREATE INDEX "ProviderVerificationAttachment_providerId_idx" ON "ProviderVerificationAttachment"("providerId");

-- CreateIndex
CREATE INDEX "ProviderVerificationAttachment_uploaderUserId_idx" ON "ProviderVerificationAttachment"("uploaderUserId");

-- CreateIndex
CREATE INDEX "ProviderVerificationAttachment_createdAt_idx" ON "ProviderVerificationAttachment"("createdAt");

-- AddForeignKey
ALTER TABLE "ProviderVerification" ADD CONSTRAINT "ProviderVerification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderVerificationAttachment" ADD CONSTRAINT "ProviderVerificationAttachment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderVerification"("providerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderVerificationAttachment" ADD CONSTRAINT "ProviderVerificationAttachment_uploaderUserId_fkey" FOREIGN KEY ("uploaderUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
