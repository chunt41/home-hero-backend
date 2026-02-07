-- Add traceable dispute resolution fields
-- This migration is safe to apply multiple times.

ALTER TABLE "Dispute"
  ADD COLUMN IF NOT EXISTS "resolvedByAdminId" INTEGER;

ALTER TABLE "Dispute"
  ADD COLUMN IF NOT EXISTS "resolutionJobStatus" "JobStatus";

DO $$
BEGIN
  BEGIN
    ALTER TABLE "Dispute"
      ADD CONSTRAINT "Dispute_resolvedByAdminId_fkey"
      FOREIGN KEY ("resolvedByAdminId")
      REFERENCES "User"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  EXCEPTION
    WHEN duplicate_object THEN
      NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS "Dispute_resolvedByAdminId_idx" ON "Dispute"("resolvedByAdminId");
