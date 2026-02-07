-- Add missing job lifecycle statuses
-- This migration is safe to apply multiple times.

DO $$
BEGIN
  -- AWARDED
  BEGIN
    ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'AWARDED';
  EXCEPTION
    WHEN duplicate_object THEN
      -- older Postgres may not support IF NOT EXISTS; ignore
      NULL;
  END;

  -- DISPUTED
  BEGIN
    ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';
  EXCEPTION
    WHEN duplicate_object THEN
      NULL;
  END;
END $$;
