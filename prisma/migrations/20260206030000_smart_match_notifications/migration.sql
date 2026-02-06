-- Smart match notifications + background job runner

-- 1) Notification.content: String -> Json (jsonb)
ALTER TABLE "Notification"
  ALTER COLUMN "content" TYPE JSONB
  USING to_jsonb("content");

-- 2) Push tokens (Expo)
CREATE TABLE "PushToken" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "token" TEXT NOT NULL,
  "platform" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "PushToken"
  ADD CONSTRAINT "PushToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken"("token");
CREATE INDEX "PushToken_userId_idx" ON "PushToken"("userId");

-- 3) Background job queue
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BackgroundJobStatus') THEN
    CREATE TYPE "BackgroundJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');
  END IF;
END$$;

CREATE TABLE "BackgroundJob" (
  "id" SERIAL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "BackgroundJobStatus" NOT NULL DEFAULT 'PENDING',
  "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 8,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");
CREATE INDEX "BackgroundJob_lockedAt_idx" ON "BackgroundJob"("lockedAt");
CREATE INDEX "BackgroundJob_createdAt_idx" ON "BackgroundJob"("createdAt");

-- 4) Dedup: track which providers were notified for a job
CREATE TABLE "JobMatchNotification" (
  "id" SERIAL PRIMARY KEY,
  "jobId" INTEGER NOT NULL,
  "providerId" INTEGER NOT NULL,
  "score" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "JobMatchNotification"
  ADD CONSTRAINT "JobMatchNotification_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobMatchNotification"
  ADD CONSTRAINT "JobMatchNotification_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "JobMatchNotification_jobId_providerId_key"
  ON "JobMatchNotification"("jobId", "providerId");

CREATE INDEX "JobMatchNotification_providerId_createdAt_idx"
  ON "JobMatchNotification"("providerId", "createdAt");

CREATE INDEX "JobMatchNotification_jobId_createdAt_idx"
  ON "JobMatchNotification"("jobId", "createdAt");
