-- Add suggested price range fields for jobs

ALTER TABLE "Job"
ADD COLUMN "suggestedMinPrice" INTEGER,
ADD COLUMN "suggestedMaxPrice" INTEGER,
ADD COLUMN "suggestedReason" TEXT;
