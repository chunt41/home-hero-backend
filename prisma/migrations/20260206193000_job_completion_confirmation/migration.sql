-- Add completion confirmation + timestamp fields
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "completionPendingForUserId" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Add enum value for completion pending confirmation
DO $$
BEGIN
  ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'COMPLETED_PENDING_CONFIRMATION';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Foreign key for completionPendingForUserId
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Job_completionPendingForUserId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_completionPendingForUserId_fkey"
      FOREIGN KEY ("completionPendingForUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS "Job_completionPendingForUserId_idx" ON "Job"("completionPendingForUserId");
CREATE INDEX IF NOT EXISTS "Job_completedAt_idx" ON "Job"("completedAt");
