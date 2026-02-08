# Cutover Runbook: Staging → Production

This document is the single step-by-step runbook to cut over a release from staging to production **without tribal knowledge**.

Scope:
- Backend deploy + DB migrations (Prisma)
- Env validation / production guardrails
- Attachment storage migration (legacy disk → object storage)
- Stripe webhook secret rotation
- Smoke tests
- Feature enablement (attestation enforcement, job match digest mode)
- Monitoring checks

Assumptions:
- You can update production environment variables (e.g., Railway).
- You can run one-off commands in the production environment (Railway shell / container).
- You have access to Stripe Dashboard (Live) and the DB provider.

Quick references:
- Deployment gate: [docs/deployment-gate.md](deployment-gate.md)
- Production checklist: [docs/production-checklist.md](production-checklist.md)
- Backups and restore: [docs/backups.md](backups.md)
- Ops baseline: [docs/ops.md](ops.md)

---

## Pre-flight (do before starting the ordered cutover)

1) Identify the **RC commit SHA** to deploy.
2) Confirm CI is green on that SHA.
3) Take a DB snapshot / backup.
   - Follow [docs/backups.md](backups.md) (preferred: provider snapshot or `scripts/db/backup.*`).
4) Confirm you have these URLs handy:
   - Production base URL: `PROD_BASE_URL=https://<your-prod-host>`
   - Staging base URL: `STAGING_BASE_URL=https://<your-staging-host>`

---

## Ordered cutover steps (exact order)

### 1) Migrations (Prisma)

Goal: apply schema migrations **once** in production.

Commands (run in the production runtime environment):
- `npm run migrate:deploy`

Expected output:
- Either `No pending migrations` or migration application logs finishing successfully.

Rollback plan:
- If migrations fail before applying anything: fix the migration and re-run.
- If migrations partially applied or schema drift is suspected:
  - Stop the rollout.
  - Prefer restoring into a new DB and cutting over `DATABASE_URL` per [docs/backups.md](backups.md).
  - Do **not** attempt manual schema surgery unless you are confident and have a verified rollback.


### 2) Env validation (production gates)

Goal: ensure production-required env vars/guardrails are satisfied **before** opening traffic.

Actions:
1) Confirm required env vars are set in production (minimum):
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `STRIPE_SECRET_KEY` (must be live in prod)
   - `RATE_LIMIT_REDIS_URL` (required in production)
   - `OBJECT_STORAGE_PROVIDER=s3` (required in production)
   - S3 credentials (`OBJECT_STORAGE_S3_*`) and optional `ATTACHMENTS_SIGNED_URL_TTL_SECONDS`

2) Validate via the readiness suite (CI / local):
   - `npm run readiness`

3) Validate via prod endpoints after deploy (once the new build is up):
   - `GET /healthz` → expects `200` with `{ ok: true }`
   - `GET /readyz` → expects `200` with `{ ok: true, db: true }`

Rollback plan:
- If readiness fails due to missing env:
  - Do **not** proceed.
  - Fix env vars and redeploy/restart.
- If `readyz` fails due to DB connectivity:
  - Roll back the deploy (previous build) or restore DB connectivity before continuing.


### 3) Storage migration (legacy disk uploads → object storage)

Goal: ensure production uses object storage for new uploads and (optionally) migrate legacy `diskPath` uploads to `storageKey`.

Pre-req:
- Production must already have `OBJECT_STORAGE_PROVIDER=s3` and valid credentials.

Actions:
1) Confirm new uploads are object-storage backed (post-deploy behavior check):
   - Upload a small attachment and confirm the row has `storageKey` (not only `diskPath`).

2) If legacy uploads exist and you are migrating them:
   - Dry run first:
     - `npm run migrate:attachments -- --dry-run --limit=20 --concurrency=5`
   - Then run the migration (start conservative):
     - `npm run migrate:attachments -- --limit=200 --concurrency=5`

Post-check:
- Request `GET /attachments/:id` for a migrated attachment and confirm it redirects (`302`) to a signed URL.

Rollback plan:
- If object storage credentials are wrong:
  - Fix env vars; do not continue.
- If the legacy migration causes issues:
  - The safe rollback is to clear `storageKey` for affected rows so reads fall back to disk (see rollback section in [docs/production-checklist.md](production-checklist.md)).
  - Keep `diskPath` until migrations are fully verified.


### 4) Webhook secret rotation (Stripe)

Goal: rotate the Stripe webhook signing secret safely.

Important:
- This codebase expects a single `STRIPE_WEBHOOK_SECRET` at a time.
- Plan a short window where webhook verification may fail if you rotate in Stripe but have not yet updated production env.

Actions (recommended safest sequence):
1) In Stripe Dashboard (Live), locate the existing webhook endpoint for:
   - `POST https://<prod-host>/payments/webhook`
2) Prepare the production env edit UI (Railway) with the current `STRIPE_WEBHOOK_SECRET` visible (copy it to a secure note).
3) Rotate the signing secret in Stripe (endpoint settings).
4) Immediately update production env var:
   - Set `STRIPE_WEBHOOK_SECRET` to the new `whsec_...`
5) Trigger a Stripe test event delivery and confirm it returns `2xx` and is processed.
   - Also verify `GET /payments/health` (admin-only) returns `ok: true` and indicates live mode.

Rollback plan:
- If you have **not** rotated in Stripe yet: revert the env change to the previous secret.
- If you already rotated and webhooks are failing:
  - Rotate the endpoint secret again to a fresh secret and update `STRIPE_WEBHOOK_SECRET` to match.
  - Rely on replay safety: Stripe will retry deliveries and the backend is idempotent.


### 5) Smoke tests

Goal: confirm critical production behaviors end-to-end.

Actions:
1) Health:
   - `GET /healthz` → `200` `{ ok: true }`
   - `GET /readyz` → `200` `{ ok: true, db: true }`

2) Auth basics:
   - Attempt a login with a known test account (or verify `/auth/login` responds).

3) Stripe webhooks:
   - Send a Stripe test event → confirm `2xx` and no errors.

4) Attachments (if enabled in prod):
   - Upload a small image attachment and confirm retrieval works (redirect to signed URL or stream depending on storage).

Optional scripts (local/dev oriented; adapt base URL if needed):
- Attachment flows smoke (PowerShell): `scripts/smokeAttachments.ps1`
- SecurityEvent logging E2E (Node): `node scripts/smokeSecurityEventsE2E.cjs`

Rollback plan:
- If any smoke test fails:
  - Stop and roll back the deploy to the previous known-good build.
  - If failure is data/schema related, prefer DB restore/cutover per [docs/backups.md](backups.md).


### 6) Feature flag enablement

This step is where you turn on “production behavior changes” that are intentionally gated.

#### 6a) Attestation enforcement

Goal: enforce app attestation on sensitive routes.

Actions:
1) Ensure verifier config exists (Android and/or iOS) and has been validated by `npm run readiness`.
2) Set in production:
   - `APP_ATTESTATION_ENFORCE=true`
   - (Optional) `APP_ATTESTATION_PLATFORMS=android,ios`
3) Deploy/restart the service.
4) Verify from a real production app build that sensitive routes work.
5) Verify that unauthenticated/untokened sensitive routes are blocked (expected).

Rollback plan:
- Set `APP_ATTESTATION_ENFORCE=false` and redeploy/restart.

#### 6b) Job match digest mode

Goal: enable digest-mode delivery for job match notifications.

Notes:
- Digest mode is primarily controlled by per-user notification preferences (e.g., `matchDeliveryMode=DIGEST` and `digestIntervalMinutes`).
- There is no single backend env flag that “turns on digest” globally; rollout is typically done by shipping the mobile UI and enabling it for users.

Actions:
1) Confirm production has a running worker (digest jobs rely on background processing):
   - Worker process should be running (`npm run worker` in prod).
2) In a production test account (PRO provider), enable digest mode via the app settings UI.
3) Create a test job that should match the provider and confirm:
   - Immediate providers still get immediate push
   - Digest providers accumulate and receive a digest notification at the configured interval

Rollback plan:
- Disable digest for affected accounts via settings (set delivery mode back to immediate).
- If the worker is causing issues, stop the worker process (temporary mitigation) and revert after investigation.


### 7) Monitoring checks

Goal: confirm production is healthy and alerts/telemetry look normal.

Actions:
1) Logs:
   - Confirm no elevated `5xx` rates and no repeated error logs.

2) Sentry (if enabled):
   - Confirm no new spike in exceptions.

3) Stripe:
   - Confirm webhook deliveries show success.

4) Ops endpoints (admin-only):
   - `GET /admin/ops/kpis`
   - `GET /admin/ai/metrics` (AI usage, cache hit ratio, blocked calls, top cost users)

Rollback plan:
- If monitoring indicates a production incident:
  - Roll back to last known-good build.
  - If the issue is data/schema, follow restore/cutover in [docs/backups.md](backups.md).

---

## Final Go/No-Go checklist (copy/paste)

Fill this in during the cutover.

### A) Pre-flight confirmations
- [ ] RC commit SHA: `__________`
- [ ] CI green on SHA (link): `__________`
- [ ] DB backup/snapshot completed (timestamp): `__________`

### B) Step 1 — migrations
Command:
- `npm run migrate:deploy`

Output (paste):
- ```
  <paste output>
  ```

### C) Step 2 — env validation
Commands:
- `npm run readiness`
- `curl -sS $PROD_BASE_URL/healthz`
- `curl -sS $PROD_BASE_URL/readyz`

Outputs (paste):
- ```
  <paste readiness output>
  ```
- ```
  <paste /healthz>
  ```
- ```
  <paste /readyz>
  ```

### D) Step 3 — storage migration
Commands (if migrating legacy uploads):
- `npm run migrate:attachments -- --dry-run --limit=20 --concurrency=5`
- `npm run migrate:attachments -- --limit=200 --concurrency=5`

Outputs (paste):
- ```
  <paste output>
  ```

### E) Step 4 — webhook secret rotation
- [ ] Stripe endpoint secret rotated
- [ ] Production `STRIPE_WEBHOOK_SECRET` updated
- [ ] Stripe test event delivered successfully

Evidence (paste):
- Stripe test delivery status: `__________`
- `GET /payments/health` output:
  - ```
    <paste output>
    ```

### F) Step 5 — smoke tests
- [ ] `/healthz` OK
- [ ] `/readyz` OK
- [ ] Auth/login sanity OK
- [ ] Attachment upload/retrieval OK (if applicable)

Evidence (paste):
- ```
  <paste notes>
  ```

### G) Step 6 — feature enablement
Attestation:
- [ ] `APP_ATTESTATION_ENFORCE=true` applied
- [ ] Real client can call sensitive routes
- [ ] Non-attested calls are blocked (expected)

Digest mode:
- [ ] Worker running
- [ ] Test provider set to digest mode
- [ ] Digest notification observed at interval

### H) Step 7 — monitoring checks
- [ ] Logs normal (no error spike)
- [ ] Sentry normal (no exception spike)
- [ ] Stripe webhook deliveries normal
- [ ] `/admin/ops/kpis` looks sane
- [ ] `/admin/ai/metrics` looks sane (cache hit ratio, blocked calls)

### GO / NO-GO
- Decision: **GO** / **NO-GO**
- Owner: `__________`
- Timestamp (UTC): `__________`
- Notes: `__________`
