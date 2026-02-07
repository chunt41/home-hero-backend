-- CreateEnum
CREATE TYPE "ContactExchangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ContactExchangeRequest" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "requestedByUserId" INTEGER NOT NULL,
    "status" "ContactExchangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ContactExchangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactExchangeRequest_jobId_status_idx" ON "ContactExchangeRequest"("jobId", "status");

-- CreateIndex
CREATE INDEX "ContactExchangeRequest_jobId_createdAt_idx" ON "ContactExchangeRequest"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "ContactExchangeRequest_requestedByUserId_createdAt_idx" ON "ContactExchangeRequest"("requestedByUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "ContactExchangeRequest" ADD CONSTRAINT "ContactExchangeRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactExchangeRequest" ADD CONSTRAINT "ContactExchangeRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
