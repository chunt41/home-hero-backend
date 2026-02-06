-- CreateTable
CREATE TABLE "ProviderStats" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "avgRating" DOUBLE PRECISION,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "jobsCompletedAllTime" INTEGER NOT NULL DEFAULT 0,
    "jobsCompleted30d" INTEGER NOT NULL DEFAULT 0,
    "medianResponseTimeSeconds30d" INTEGER,
    "cancellationRate30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "disputeRate30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reportRate30d" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderStats_providerId_key" ON "ProviderStats"("providerId");

-- CreateIndex
CREATE INDEX "ProviderStats_providerId_idx" ON "ProviderStats"("providerId");

-- CreateIndex
CREATE INDEX "ProviderStats_updatedAt_idx" ON "ProviderStats"("updatedAt");

-- AddForeignKey
ALTER TABLE "ProviderStats" ADD CONSTRAINT "ProviderStats_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
