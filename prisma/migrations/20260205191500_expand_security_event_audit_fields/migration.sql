-- Expand SecurityEvent to support richer audit/security logging

ALTER TABLE "SecurityEvent"
ADD COLUMN IF NOT EXISTS "actorRole" "UserRole",
ADD COLUMN IF NOT EXISTS "targetType" TEXT,
ADD COLUMN IF NOT EXISTS "targetId" TEXT;

-- Optional helper indexes for filtering
CREATE INDEX IF NOT EXISTS "SecurityEvent_actorRole_idx" ON "SecurityEvent"("actorRole");
CREATE INDEX IF NOT EXISTS "SecurityEvent_targetType_idx" ON "SecurityEvent"("targetType");
CREATE INDEX IF NOT EXISTS "SecurityEvent_targetId_idx" ON "SecurityEvent"("targetId");
