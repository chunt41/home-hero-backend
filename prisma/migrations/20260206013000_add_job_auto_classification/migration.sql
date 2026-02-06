-- Add job auto-classification fields
ALTER TABLE "Job"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "trade" TEXT,
  ADD COLUMN "urgency" TEXT,
  ADD COLUMN "suggestedTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
