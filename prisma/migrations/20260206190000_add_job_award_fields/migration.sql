-- Add job award fields (non-breaking)
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "awardedProviderId" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "awardedAt" TIMESTAMP(3);

-- Foreign key to User(id) for awarded provider
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Job_awardedProviderId_fkey'
  ) THEN
    ALTER TABLE "Job"
      ADD CONSTRAINT "Job_awardedProviderId_fkey"
      FOREIGN KEY ("awardedProviderId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Index for queries by awarded provider
CREATE INDEX IF NOT EXISTS "Job_awardedProviderId_idx" ON "Job"("awardedProviderId");
