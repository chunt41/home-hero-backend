# Release Candidate (RC) Checklist

This document is the single go/no-go checklist for a release candidate.

## One command (automated go/no-go)

Run from repo root:

- `npm run rc:verify`

Expected output:
- `npm run lint` succeeds (TypeScript noEmit)
- `npm test` passes
- `npm run verify:gate` passes
- Smoke suite passes (`[rc:smoke] OK`)
- Final line includes `[rc:verify] OK`

Smoke configuration (optional):
- URL override: `RC_SMOKE_URL=http://127.0.0.1:4000 npm run rc:verify`
- If you already have the server running: `RC_SMOKE_START_SERVER=0 npm run rc:verify`
- Allow DB down (only for API-only verification): `RC_SMOKE_ALLOW_DB_DOWN=1 npm run rc:verify`
- Emergency skip: `RC_SMOKE_SKIP=1 npm run rc:verify`

Smoke coverage:
- `GET /healthz`, `GET /readyz`
- Auth: `POST /auth/signup` → `POST /auth/verify-email` → `POST /auth/login`
- Provider search: `GET /providers/search?zip=...`
- Job flow: `POST /jobs` → `POST /jobs/:jobId/bids` → `POST /jobs/:jobId/messages`
- Notifications: `GET /notifications` and `GET /me/notifications`

---

## RC items (commands + expected results)

The single command `npm run rc:verify` covers the automated items below.

### 1) CI workflows

- Verify GitHub Actions checks for the RC commit are green (lint, tests, readiness/gates).
- Local equivalent:
  - `npm run ci`
  - Expected: exits `0`.

Automated (RC one-command):
- `npm run rc:verify`
- Expected: exits `0`.

### 2) Env validation (production gates)

- Run:
  - `npm run readiness`
  - Expected: exits `0`.

What this covers:
- Production-required env var validation, readiness endpoints, and safety gates.

Note:
- `npm run rc:verify` includes `npm run verify:gate`, but does not run `npm run readiness`.

### 3) Database migrations

- Ensure migrations are present and applied in the target environment.
- Local/schema sanity:
  - `npx prisma migrate status`
  - Expected: reports no drift and all migrations either applied (on a real DB) or pending as expected.

Deploy-time command (target environment):
- `npm run migrate:deploy`
- Expected: `No pending migrations` or successful application of pending migrations.

Note:
- The smoke suite in `npm run rc:verify` expects a working DB (unless `RC_SMOKE_ALLOW_DB_DOWN=1`).

### 4) Storage migration (attachments)

If you are migrating from legacy disk-backed uploads (`diskPath`) to object storage (`storageKey`):

- Dry run (safe):
  - `npm run migrate:attachments -- --dry-run --limit=20`
  - Expected: logs `[migrate] starting` and migration/skips; exits `0`.

- Real run (only after confirming object storage env is configured):
  - `npm run migrate:attachments -- --concurrency=5`
  - Expected: logs progress and a non-zero `migrated` count; exits `0`.

Post-check:
- Confirm new uploads in production write `storageKey` (not `diskPath`).

### 5) Webhook idempotency

Automated:
- Included in `npm run verify:gate`.
- Expected: tests for Stripe/payment webhook idempotency pass.

Manual spot-check (staging/prod):
- Replay a known webhook event (or trigger duplicate delivery from provider dashboard) and confirm:
  - No duplicate subscription upgrades / side effects
  - Logs show idempotent handling

### 6) Messaging anti-scam / moderation

Automated:
- Included in `npm run verify:gate`.
- Expected: message moderation / risk scoring tests pass.

Manual spot-check:
- Try sending contact info pre-award (should be blocked) and post-award (should be allowed).

### 7) Notifications + preferences

Automated:
- Included in `npm run verify:gate` (push notification behavior tests).

Manual spot-check (staging build):
- In app, open Notification Settings.
- Toggle preferences and verify:
  - A test notification respects preferences
  - Quiet hours / suppression behaves as expected (if enabled)

### 8) Load tests (basic)

Goal: detect obvious regressions in latency/error rate.

- Start the server locally (with a real DB/Redis if applicable):
  - `npm run dev`

- Run a quick HTTP load probe (no new dependencies; uses npx):
  - `npx autocannon -c 25 -d 20 http://127.0.0.1:4000/healthz`
  - Expected: near-100% 2xx, low error count.

If you want a more representative endpoint, use a public browse/search route (avoid authenticated endpoints).

---

## Go / No-Go decision

GO if:
- `npm run rc:verify` passes
- CI is green for the RC commit
- Migrations + storage migration (if applicable) are complete
- Manual spot-checks (webhooks, moderation, notifications) behave as expected

NO-GO if:
- Any `rc:verify` step fails
- Migration drift is detected
- Smoke `/readyz` fails due to DB connectivity (unless intentionally running without DB)
- Any manual spot-check indicates a safety/compliance regression
