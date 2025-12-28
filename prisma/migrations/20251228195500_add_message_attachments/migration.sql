-- Add upload metadata to JobAttachment
ALTER TABLE "JobAttachment"
  ADD COLUMN IF NOT EXISTS "mimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "filename" TEXT,
  ADD COLUMN IF NOT EXISTS "sizeBytes" INTEGER;

-- MessageAttachment table (for message-level attachments)
CREATE TABLE IF NOT EXISTS "MessageAttachment" (
  "id" SERIAL PRIMARY KEY,
  "messageId" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  "mimeType" TEXT,
  "filename" TEXT,
  "sizeBytes" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");
