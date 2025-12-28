/*
  Warnings:

  - A unique constraint covering the columns `[jobId,providerId]` on the table `Bid` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Bid_jobId_providerId_key" ON "Bid"("jobId", "providerId");
