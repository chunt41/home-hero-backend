-- Backfill Notification.readAt for existing read=true rows.
-- We don't know the true historical read time; use createdAt as a stable, deterministic fallback.

UPDATE "Notification"
SET "readAt" = COALESCE("readAt", "createdAt")
WHERE "read" = true
  AND "readAt" IS NULL;
