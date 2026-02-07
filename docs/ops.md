# Ops / Observability Baseline

This backend includes a minimal production-grade ops baseline: request IDs, structured JSON logging, optional Sentry error reporting, and health/readiness endpoints.

## Request IDs

- Every request gets a `req.id`.
- The server always responds with `X-Request-Id: <id>`.
- If the client sends `X-Request-Id`, it is honored (sanitized + length limited) to support end-to-end tracing.

## Structured logging (JSON)

HTTP access logs are emitted as single-line JSON to stdout/stderr.

Fields:
- `timestamp` (ISO)
- `level`
- `message` (e.g. `http.request`)
- `reqId`
- `route`
- `method`
- `status`
- `durationMs`
- `userId` (if present)

## Sentry (optional)

If `SENTRY_DSN` is set, Sentry is initialized and:
- Express error handler captures exceptions
- `uncaughtException` / `unhandledRejection` are captured before shutdown

Env vars:
- `SENTRY_DSN` (optional)

## Health endpoints

- `GET /healthz` → always returns 200 `{ ok: true }`
- `GET /readyz` → returns 200 if DB is reachable, else 503

These endpoints are intentionally **unauthenticated** for use with load balancers and platform health checks.

## Environment validation / fail-fast

Production should provide secrets via environment variables. Required env vars are validated on startup.

This codebase includes a few explicit fail-fast guardrails in production:

- **Redis rate limiting**: requires `RATE_LIMIT_REDIS_URL` when `NODE_ENV=production`.
- **Attachment object storage**: requires `OBJECT_STORAGE_PROVIDER=s3` when `NODE_ENV=production`, unless `OBJECT_STORAGE_ALLOW_DISK_IN_PROD=true` is set.
- **App attestation**: if `APP_ATTESTATION_ENFORCE=true` in production, platform verifier configuration must be present (Android Play Integrity and/or iOS App Attest, depending on `APP_ATTESTATION_PLATFORMS`).

## App attestation (optional, recommended)

When enabled, sensitive endpoints require a valid attestation token.

Client headers:
- `X-App-Platform: android|ios`
- `X-App-Attestation: <token>`
- `X-App-Attestation-Nonce: <nonce>` (optional; if your mobile app supports nonce binding)

Env vars (high level):
- `APP_ATTESTATION_ENFORCE=true|false`
- `ALLOW_UNATTESTED_DEV=true|false` (dev-only bypass; ignored in production)
- `APP_ATTESTATION_PLATFORMS=android,ios` (optional; defaults to both)

Android (Play Integrity):
- `ANDROID_PLAY_INTEGRITY_PACKAGE_NAME`
- `ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS`
- One of: `GOOGLE_SERVICE_ACCOUNT_JSON` | `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | `GOOGLE_APPLICATION_CREDENTIALS`

iOS (App Attest):
- `IOS_APP_ATTEST_BUNDLE_ID`
- `IOS_APP_ATTEST_ALLOWED_KEY_IDS` (or `*`)
- `IOS_APP_ATTEST_VERIFY_URL`
- `IOS_APP_ATTEST_VERIFY_AUTH_HEADER` (optional)

Note: There is also a legacy JWT-based verifier for backwards compatibility if older clients send a JWT instead of a platform token.

## Auth brute-force protection (Redis-backed)

Login throttling uses Redis (same Redis URL as rate limiting) to track failure windows and cooldowns.

Optional tuning env vars:
- `LOGIN_BRUTE_FORCE_WINDOW_MS`
- `LOGIN_BRUTE_FORCE_COOLDOWN_MS`
- `LOGIN_BRUTE_FORCE_MAX_FAILS_IP`
- `LOGIN_BRUTE_FORCE_MAX_FAILS_EMAIL`

## Attachments: private object storage (recommended)

Attachments can be stored privately in S3/R2-compatible object storage and served via short-lived signed URLs.

Behavior:
- New uploads write to object storage when `OBJECT_STORAGE_PROVIDER=s3`.
- `GET /attachments/:id` and `GET /provider/verification/attachments/:id` authorize as before, then redirect (`302`) to a signed URL when an attachment has a `storageKey`.
- Backward compatibility: if an attachment has `diskPath` but no `storageKey`, it is streamed from local disk.

Production enforcement:
- In `NODE_ENV=production`, object storage is required unless you set `OBJECT_STORAGE_ALLOW_DISK_IN_PROD=true` (emergency escape hatch).

Env vars:
- `OBJECT_STORAGE_PROVIDER`: `s3` (recommended) or unset/other (disk fallback)
- `OBJECT_STORAGE_S3_BUCKET`
- `OBJECT_STORAGE_S3_REGION`
- `OBJECT_STORAGE_S3_ACCESS_KEY_ID`
- `OBJECT_STORAGE_S3_SECRET_ACCESS_KEY`
- `OBJECT_STORAGE_S3_ENDPOINT` (optional; required for Cloudflare R2)
- `OBJECT_STORAGE_S3_FORCE_PATH_STYLE` (optional; useful for some S3-compatible providers)
- `ATTACHMENTS_SIGNED_URL_TTL_SECONDS` (optional; default `300`)

One-off migration:
- Use [scripts/migrateUploadsToObjectStorage.ts](../scripts/migrateUploadsToObjectStorage.ts) to backfill `storageKey` for existing rows that still reference `diskPath`.

## CI / dependency scanning

Scripts:
- `npm run lint` → TypeScript typecheck (`tsc --noEmit`)
- `npm test` → Node test runner
- `npm run audit` → `npm audit --audit-level=critical`
- `npm run ci` → `lint + test + audit`

Recommended in CI:
- Run `npm ci`
- Run `npm run ci`

## Database migrations (Prisma)

This service is designed to run **production-safe** migrations via `prisma migrate deploy`.

- In production, the `start` flow runs migrations automatically via the `listen` script in [package.json](../package.json).
- Prisma prefers `DATABASE_PRIVATE_URL` (direct connection) over `DATABASE_URL` (pooler) when available; see [prisma.config.ts](../prisma.config.ts).

Common commands:
- `npm run migrate:deploy` (apply any pending migrations)
- `npx prisma migrate status` (inspect status)

If you cannot reach the database from your laptop/network, run these from your deployment environment (e.g. Railway shell) or apply the SQL manually in Supabase.

## Known `npm audit` findings

`npm audit` may report **moderate** vulnerabilities in transitive dependencies pulled in by the Prisma CLI toolchain (e.g. `lodash` via `@prisma/dev`). At the time of writing, `npm audit fix --force` proposes a breaking Prisma downgrade to eliminate these.

Notes:
- The dependency chain currently resolves `lodash@4.17.21` (latest available), but `npm audit` still flags it.
- `npm run audit` uses `npm audit --audit-level=critical` and should exit `0` unless a critical issue is present.

Current stance:
- CI runs `npm audit --audit-level=critical` so **critical** issues fail builds.
- Moderate findings in Prisma tooling are tracked and revisited on Prisma updates, rather than forcing breaking changes.
