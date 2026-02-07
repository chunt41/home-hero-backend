-- Add storageKey columns to support object storage for attachments.

ALTER TABLE "JobAttachment" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "MessageAttachment" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "ProviderVerificationAttachment" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
