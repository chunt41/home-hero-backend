/*
  Warnings:

  - The `status` column on the `StripePayment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `tier` on the `StripePayment` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "StripePayment" DROP COLUMN "tier",
ADD COLUMN     "tier" "SubscriptionTier" NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "StripePayment_status_idx" ON "StripePayment"("status");
