-- CreateEnum
CREATE TYPE "CounterStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "CounterOffer" (
    "id" SERIAL NOT NULL,
    "bidId" INTEGER NOT NULL,
    "minAmount" INTEGER,
    "maxAmount" INTEGER,
    "amount" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "status" "CounterStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CounterOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CounterOffer_bidId_key" ON "CounterOffer"("bidId");

-- AddForeignKey
ALTER TABLE "CounterOffer" ADD CONSTRAINT "CounterOffer_bidId_fkey" FOREIGN KEY ("bidId") REFERENCES "Bid"("id") ON DELETE CASCADE ON UPDATE CASCADE;
