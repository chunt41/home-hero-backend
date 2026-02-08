-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "cancellationReasonCode" TEXT,
ADD COLUMN     "cancellationReasonDetails" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledByUserId" INTEGER;

-- CreateIndex
CREATE INDEX "Job_cancelledAt_idx" ON "Job"("cancelledAt");

-- CreateIndex
CREATE INDEX "Job_cancelledByUserId_idx" ON "Job"("cancelledByUserId");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
