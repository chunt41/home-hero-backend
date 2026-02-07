# Home Hero Backend

Node/Express + TypeScript + Prisma.

## Local dev

- Install deps: `npm install`
- Configure env:
  - Copy `.env.example` → `.env` (app runtime)
  - Copy `.env.prisma.example` → `.env.prisma` (Prisma CLI)
- Start a local Postgres (optional): see `docker-compose.dev.yml`
- Run migrations: `npm run migrate:deploy`
- Start dev server: `npm run dev`

## Tests

- Typecheck: `npm run lint`
- Tests: `npm test`

## Production required env vars

Required for a healthy production deploy:

- `NODE_ENV=production`
- `DATABASE_URL`
- `JWT_SECRET`
- Stripe:
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET` (required if running Stripe webhooks)
- Redis rate limiting (required): `RATE_LIMIT_REDIS_URL`
- Attachments (required unless escape hatch):
  - `OBJECT_STORAGE_PROVIDER=s3`
  - `OBJECT_STORAGE_S3_BUCKET`
  - `OBJECT_STORAGE_S3_REGION`
  - `OBJECT_STORAGE_S3_ACCESS_KEY_ID`
  - `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`

Conditionally required:

- App attestation (only if enabled): set `APP_ATTESTATION_ENFORCE=true` and configure Android/iOS verifier env vars.

## Production guardrails (important)

These are fail-fast / enforced behaviors that matter at deploy time:

- Redis rate limiting: `RATE_LIMIT_REDIS_URL` is required when `NODE_ENV=production`.
- Attachments storage: object storage is required in production.
  - Set `OBJECT_STORAGE_PROVIDER=s3` and configure `OBJECT_STORAGE_S3_*`.
  - Object storage is required in production.
- App attestation (optional, but if enabled it must be configured):
  - Set `APP_ATTESTATION_ENFORCE=true`.
  - Configure Android Play Integrity vars if serving Android.
  - Configure iOS App Attest vars (and provider URL) if serving iOS.

See `docs/production-checklist.md` and `docs/ops.md` for the full deployment checklist and operational notes.

## Migrating existing uploads to object storage

If you previously stored attachments on disk and are moving to S3/R2:

- Run: `npm run migrate:attachments -- --dry-run`
- Then: `npm run migrate:attachments -- --delete-local`

Script: `scripts/migrateUploadsToObjectStorage.ts`
