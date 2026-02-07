-- CreateIndex
CREATE INDEX "Bid_jobId_createdAt_idx" ON "Bid"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "Bid_providerId_createdAt_idx" ON "Bid"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_consumerId_createdAt_idx" ON "Job"("consumerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Message_jobId_createdAt_idx" ON "Message"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");
