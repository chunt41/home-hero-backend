# Production readiness gate (Home Hero backend)

This doc is the **deployment gate checklist** for the backend. It includes what must be true before a deploy, plus the automated checks that enforce the guardrails.

## Automated gate (CI)

CI must run and pass:

- `npm run lint`
- `npm test`
- `npm run readiness`

The readiness suite is a small set of tests that assert production guardrails, endpoint contracts, and env-example completeness.

## Required env vars validation (guardrails)

### Always required (process must not start without these)

- `DATABASE_URL`
- `JWT_SECRET`
- `STRIPE_SECRET_KEY`

These are enforced by runtime env loading in `src/config/env.ts`.

### Required in production (startup must fail fast)

**Redis rate limiting**
- `RATE_LIMIT_REDIS_URL`
- Enforced by `validateRateLimitRedisStartupOrThrow()`.

**Attachments object storage**
- In production, `OBJECT_STORAGE_PROVIDER` must be `s3`.
- Object storage is required in production.
- If `OBJECT_STORAGE_PROVIDER=s3`, the following must be set:
  - `OBJECT_STORAGE_S3_BUCKET`
  - `OBJECT_STORAGE_S3_REGION`
  - `OBJECT_STORAGE_S3_ACCESS_KEY_ID`
  - `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`

**App attestation (only if you enable enforcement)**
- If `APP_ATTESTATION_ENFORCE=true` in production, the server must have full verifier config.
- See `.env.example` for the Android/iOS-specific required keys.

Automated checks:
- `src/productionReadiness/startupGuards.test.ts`
- `.env.example` completeness: `src/productionReadiness/envExample.test.ts`

## Health/readiness endpoints (expected behavior)

These endpoints are used by load balancers / Kubernetes probes:

- `GET /healthz`
  - **200** when the process is up.
  - No DB check.
- `GET /readyz`
  - **200** when the DB is reachable (`SELECT 1`).
  - **503** when DB is unreachable.

Human/debug endpoints (useful for operators):

- `GET /health`
  - Returns service metadata (env + timestamp).
- `GET /health/db`
  - Returns DB up/down details.
- `GET /ready`
  - Returns readiness details (DB + worker status).

Automated check:
- `src/productionReadiness/healthRoutesContract.test.ts` (ensures endpoints exist and avoids shipping emoji payloads).

## Webhook idempotency (must hold)

Required properties:

- Stripe webhooks must be **idempotent**.
- Replayed events must not double-apply subscription tier or entitlements.

Automated checks:
- Existing unit tests already cover webhook replay/idempotency behavior (search test output for: `replayed webhook does not double-apply subscription tier`).
- Payments confirm route must stay read-only.

## Rate limit integration (must hold)

Required properties:

- Redis-backed rate limiting is enabled in production.
- Requests are blocked when over limit.

Automated checks:
- Existing Redis rate limit integration tests (see `rateLimitRedis` tests in `src/**`).

## Attachment authorization (must hold)

Required properties:

- Attachments are only accessible to authorized users (job consumer, awarded provider, admins).
- Path traversal is blocked.
- If using object storage, signed URLs are only generated for authorized callers.

Automated checks:
- Existing attachment route tests (see `GET /attachments/:id ...` tests in `src/**`).

## Job lifecycle transition correctness (must hold)

Required properties:

- Strict job state transitions (award → start → complete/confirm) must be enforced.
- Disputes only open in allowed states, and resolving disputes finalizes the job.
- Reviews only allowed when job is `COMPLETED`.

Automated checks:
- Existing lifecycle, dispute, and review tests (see `POST /jobs/:id/*` tests in `src/**`).

## Go / No-Go deployment checklist

### Go (all must be true)

- CI green on the commit:
  - `npm run lint`
  - `npm test`
  - `npm run readiness`
- DB migrations applied (`prisma migrate deploy`).
- Required production env vars configured:
  - `DATABASE_URL`, `JWT_SECRET`, `STRIPE_SECRET_KEY`
  - `RATE_LIMIT_REDIS_URL`
  - `OBJECT_STORAGE_PROVIDER=s3` (or explicit escape hatch approved)
  - If enforcing attestation: all Android/iOS verifier keys present
- Stripe webhooks configured and secret present (`STRIPE_WEBHOOK_SECRET`).
- Object storage bucket exists and credentials are valid.
- Observability:
  - Error reporting configured (optional but recommended): `SENTRY_DSN`
  - Logs retained and searchable.
- Worker is running (webhook delivery processor).

### No-Go (block deploy)

- Readiness suite fails.
- Redis rate limiting not configured for production.
- Object storage is still on disk in production without explicit approval.
- Attestation enforcement enabled but verifier configuration incomplete.
- Stripe webhook secret missing or unconfigured.
- Any attachment authorization tests failing.
- Any job lifecycle/review/dispute tests failing.
