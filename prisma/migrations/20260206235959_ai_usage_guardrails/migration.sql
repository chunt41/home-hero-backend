-- AI usage guardrails: quota fields + cache

-- Add quota tracking columns to User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "aiMonthlyTokenLimit" INTEGER,
  ADD COLUMN IF NOT EXISTS "aiTokensUsedThisMonth" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "aiUsageMonthKey" TEXT;

-- Cache table (keyed by sha256(taskType + normalizedInput))
CREATE TABLE IF NOT EXISTS "AiCacheEntry" (
  "key" TEXT NOT NULL,
  "taskType" TEXT NOT NULL,
  "normalizedInput" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "model" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),

  CONSTRAINT "AiCacheEntry_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "AiCacheEntry_taskType_idx" ON "AiCacheEntry"("taskType");
CREATE INDEX IF NOT EXISTS "AiCacheEntry_createdAt_idx" ON "AiCacheEntry"("createdAt");
CREATE INDEX IF NOT EXISTS "AiCacheEntry_expiresAt_idx" ON "AiCacheEntry"("expiresAt");
