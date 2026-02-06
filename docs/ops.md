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

Current stance:
- CI runs `npm audit --audit-level=critical` so **critical** issues fail builds.
- Moderate findings in Prisma tooling are tracked and revisited on Prisma updates, rather than forcing breaking changes.
