-- CreateTable
CREATE TABLE "BidTemplate" (
    "id" SERIAL NOT NULL,
    "providerId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "defaultAmount" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BidTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderQuickReply" (
    "id" SERIAL NOT NULL,
    "providerId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderQuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BidTemplate_providerId_idx" ON "BidTemplate"("providerId");

-- CreateIndex
CREATE INDEX "BidTemplate_createdAt_idx" ON "BidTemplate"("createdAt");

-- CreateIndex
CREATE INDEX "ProviderQuickReply_providerId_idx" ON "ProviderQuickReply"("providerId");

-- CreateIndex
CREATE INDEX "ProviderQuickReply_createdAt_idx" ON "ProviderQuickReply"("createdAt");

-- AddForeignKey
ALTER TABLE "BidTemplate" ADD CONSTRAINT "BidTemplate_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderQuickReply" ADD CONSTRAINT "ProviderQuickReply_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
