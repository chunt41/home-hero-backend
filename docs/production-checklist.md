# Production Checklist (Stripe + AdMob)

## Stripe (Live)

### 1) Environment variables (Railway)
Set these on the Railway service (do **not** commit to git):

- `DATABASE_URL`
- `JWT_SECRET`
- `RATE_LIMIT_REDIS_URL` (required in production; Redis-backed rate limiting)
- `RATE_LIMIT_REDIS_PREFIX` (optional; default `rl`)
- `STRIPE_SECRET_KEY` (must be `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET` (must be `whsec_...`)
- `CORS_ORIGINS` (your real origins, comma-separated)

AI (optional, recommended if AI features are enabled):

- `AI_CACHE_TTL_DAYS` (default `30`)
- `AI_TOKENS_LIMIT_FREE` (default `0`)
- `AI_TOKENS_LIMIT_BASIC` (default `2000`)
- `AI_TOKENS_LIMIT_PRO` (default `5000`)
- `AI_MONTHLY_USER_ALERT_THRESHOLD_TOKENS` (optional; alerts on heavy users)
- `AI_MODEL_CHEAP` (default `gpt-4o-mini`)
- `AI_MODEL_PREMIUM` (default `gpt-4o`)

Attachments object storage (required in `NODE_ENV=production`):

- `OBJECT_STORAGE_PROVIDER=s3`
- `OBJECT_STORAGE_S3_BUCKET`
- `OBJECT_STORAGE_S3_REGION`
- `OBJECT_STORAGE_S3_ACCESS_KEY_ID`
- `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`
- `OBJECT_STORAGE_S3_ENDPOINT` (optional; required for Cloudflare R2)
- `OBJECT_STORAGE_S3_FORCE_PATH_STYLE` (optional)
- `ATTACHMENTS_SIGNED_URL_TTL_SECONDS` (optional; default `300`)

Recommended bucket policy:
- Keep the bucket **private** (block all public access).
- Serve attachments via short-lived **pre-signed URLs** only.

### 1b) Migrate legacy disk uploads to object storage

Production is multi-instance, so **new uploads must go to object storage**. Disk is supported only for **legacy reads** (`diskPath` without `storageKey`).

This repo includes a migration script that uploads legacy files from `uploads/` to S3-compatible object storage and sets `storageKey` while keeping `diskPath` for rollback.

Prereqs:

- Confirm production env vars for S3 are set (see above)
- Ensure the production container has access to the legacy `uploads/` directory you want to migrate from

Step-by-step:

1) Run a dry run first:

- `npm run migrate:attachments -- --dry-run --limit=50 --concurrency=5`

2) Run the migration for real (start small):

- `npm run migrate:attachments -- --limit=200 --concurrency=5`

3) Increase throughput once stable:

- `npm run migrate:attachments -- --concurrency=10`

4) Validate in production:

- Pick a migrated attachment and request `GET /attachments/:id` → should return `302` to a signed URL
- For provider verification docs, request `GET /provider/verification/attachments/:id` → should return `302` to a signed URL

Notes:

- Flags supported: `--dry-run`, `--limit=<n>`, `--concurrency=<n>`
- The script is resumable; it only migrates rows where `storageKey` is null and `diskPath` is not null.

Rollback (if needed):

- Because the API prefers `storageKey` when present, you can revert reads back to disk by clearing `storageKey` for affected rows.
- Example (Postgres) — run carefully on the correct DB:
  - `UPDATE "JobAttachment" SET "storageKey" = NULL WHERE "diskPath" IS NOT NULL;`
  - `UPDATE "MessageAttachment" SET "storageKey" = NULL WHERE "diskPath" IS NOT NULL;`
  - `UPDATE "ProviderVerificationAttachment" SET "storageKey" = NULL WHERE "diskPath" IS NOT NULL;`

Keep `diskPath` until you are confident migrations are complete and verified.

- App attestation enforcement (only required if you turn it on):
  - `APP_ATTESTATION_ENFORCE=true`
  - Optional: `APP_ATTESTATION_PLATFORMS=android,ios` (defaults to both)
  - Android Play Integrity:
    - `ANDROID_PLAY_INTEGRITY_PACKAGE_NAME`
    - `ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS`
    - One of: `GOOGLE_SERVICE_ACCOUNT_JSON` | `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | `GOOGLE_APPLICATION_CREDENTIALS`
  - iOS App Attest:
    - `IOS_APP_ATTEST_BUNDLE_ID`
    - `IOS_APP_ATTEST_ALLOWED_KEY_IDS` (or `*`)
    - `IOS_APP_ATTEST_VERIFY_URL`
    - `IOS_APP_ATTEST_VERIFY_AUTH_HEADER` (optional)

### 2) Stripe webhook endpoint
In Stripe Dashboard (Live mode):

- Developers → Webhooks → **Add endpoint**
- Endpoint URL:
  - `https://home-hero-backend-production.up.railway.app/payments/webhook`
- Events to send:
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`

Copy the signing secret (`whsec_...`) into Railway as `STRIPE_WEBHOOK_SECRET`.

### 3) Verify in production
After deploying, call the admin-only endpoint:

- `GET /payments/health`

It should return `ok: true`, `stripeOk: true`, and `stripeMode: "live"`.

## AdMob (Production builds via EAS)

### 1) Build-time AdMob App IDs (native config)
These are required by the native SDK and must be present at build time.

Set as EAS secrets:

- `ADMOB_ANDROID_APP_ID` (your AdMob **App** ID)
- `ADMOB_IOS_APP_ID` (optional if shipping iOS)

### 2) Runtime ad unit IDs (Expo public)
These are bundled into the JS at build time.

Set for EAS production builds:

- `EXPO_PUBLIC_API_BASE_URL=https://home-hero-backend-production.up.railway.app`
- `EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS=...` (comma-separated)
- `EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID=...` (optional)

Make sure `EXPO_PUBLIC_ADMOB_USE_TEST_IDS` is not `true` in production.

## Notes
- Keep `.env` local only; use Railway/EAS for production secrets.
- DB schema changes ship via Prisma migrations; production deploys should run `prisma migrate deploy` (already part of the backend `start` flow).
- Backup/restore + zero-downtime migration runbook: see `docs/backups.md`.
- Rotate any keys that were ever pasted into chat/logs.
