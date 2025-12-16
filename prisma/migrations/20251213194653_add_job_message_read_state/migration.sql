-- CreateTable
CREATE TABLE "JobMessageReadState" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobMessageReadState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobMessageReadState_userId_lastReadAt_idx" ON "JobMessageReadState"("userId", "lastReadAt");

-- CreateIndex
CREATE INDEX "JobMessageReadState_jobId_lastReadAt_idx" ON "JobMessageReadState"("jobId", "lastReadAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobMessageReadState_jobId_userId_key" ON "JobMessageReadState"("jobId", "userId");

-- AddForeignKey
ALTER TABLE "JobMessageReadState" ADD CONSTRAINT "JobMessageReadState_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMessageReadState" ADD CONSTRAINT "JobMessageReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
