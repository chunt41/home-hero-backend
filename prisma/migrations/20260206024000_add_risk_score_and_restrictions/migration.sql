-- Add risk scoring + temporary restrictions

ALTER TABLE "User"
ADD COLUMN "riskScore" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "restrictedUntil" TIMESTAMP(3);

ALTER TABLE "Job"
ADD COLUMN "riskScore" INTEGER NOT NULL DEFAULT 0;
