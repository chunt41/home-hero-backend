# Backups, Restore, and Zero‑Downtime Migrations (Runbook)

This doc is written for production operators. It covers:

- Automated backup schedule (what “good” looks like)
- How to take a manual backup (before risky operations)
- How to restore production safely (without guesswork)
- How to deploy Prisma migrations with zero downtime

## Assumptions

- Postgres is the production database.
- The app uses Prisma migrations (`prisma migrate deploy`).
- You have Postgres client tools available where you run the commands (`pg_dump`, `psql`).
- You have the production connection string available as `DATABASE_URL`.

Shell note:

- The helper scripts in `scripts/db/*.sh` are **bash** scripts. Run them from a Linux shell (production container/VM, CI runner, WSL2 on Windows, or Git-Bash).
- On Linux you may need: `chmod +x scripts/db/*.sh`

Windows note:

- If you operate from Windows/PowerShell, use the equivalent `scripts/db/*.ps1` scripts.

## Automated DB backups (schedule)

You should have *automated* backups enabled at the database provider level (recommended). A safe default schedule:

- Full logical backup: **daily**
- Retention: **30–35 days**
- Optional (highly recommended): **point‑in‑time recovery (PITR)** with at least **7–14 days** retention
- Before every production schema migration: take a **manual snapshot** / on-demand backup

Minimum operational expectation:

- At least one automated backup per day
- A restore test (into a non-prod environment) at least **monthly**

## Manual backup procedure (pg_dump)

Use [scripts/db/backup.sh](../scripts/db/backup.sh).

Prereqs:

- `pg_dump` installed
- `DATABASE_URL` set

Example:

- `DATABASE_URL=... scripts/db/backup.sh`

PowerShell equivalent:

- `$env:DATABASE_URL='...'; powershell -ExecutionPolicy Bypass -File scripts/db/backup.ps1`

Output:

- Writes to `backups/` by default (e.g., `backups/db-backup-20260207-123000Z.sql.gz`)
- Creates a `.sha256` checksum when `sha256sum` is available

Recommended pre-migration backup:

- `scripts/db/backup.sh --out backups/pre-migration-$(date -u +%Y%m%d-%H%M%SZ).sql.gz`

## Restore procedure (production-safe)

Restoring *into the same production database* is risky and hard to roll back. The safest restore is:

1) Restore into a **new database**
2) Verify the restored DB
3) Cut over the application by changing `DATABASE_URL`

### Step 0 — Pick the backup and confirm integrity

- Confirm you have the intended backup file (`.sql` or `.sql.gz`).
- If there’s a checksum file, verify it:
  - `sha256sum -c backups/<file>.sha256`

### Step 1 — Create a new empty database

How you do this depends on your provider (Railway/RDS/etc). Requirements:

- A brand new DB (empty schema), reachable from your app runtime
- A connection string for it (call it `NEW_DATABASE_URL`)

### Step 2 — Restore the backup into the new database

Use [scripts/db/restore.sh](../scripts/db/restore.sh):

- `NEW_DATABASE_URL=... scripts/db/restore.sh --file backups/<backup>.sql.gz --force`

PowerShell equivalent:

- `$env:DATABASE_URL='...'; powershell -ExecutionPolicy Bypass -File scripts/db/restore.ps1 -File backups/<backup>.sql.gz -Force`

Notes:

- `--force` is required so you don’t accidentally restore to the wrong target.
- The script does **not** create the database for you.

### Step 3 — Verify the restore

Run these checks against `NEW_DATABASE_URL`:

1) Connectivity:
- `psql "$NEW_DATABASE_URL" -tAc "SELECT now();"`

2) Sanity counts (examples — adjust to your schema):
- `psql "$NEW_DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "User";'`
- `psql "$NEW_DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "Job";'`
- `psql "$NEW_DATABASE_URL" -tAc 'SELECT COUNT(*) FROM "SecurityEvent";'`

3) Prisma migration state:
- `DATABASE_URL="$NEW_DATABASE_URL" npx prisma migrate status`

PowerShell equivalent:

- `$env:DATABASE_URL='...'; npx prisma migrate status`

4) Application-level smoke test (recommended):

- Point a staging instance at `NEW_DATABASE_URL` and check:
  - `GET /health`
  - `GET /ready`
  - Sign-in flow
  - A simple read endpoint (e.g., providers search)

If the restored DB is behind on migrations, run the migration runbook below against `NEW_DATABASE_URL`.

### Step 4 — Cut over production

- Schedule a short maintenance window (even “zero downtime” cutovers benefit from a comms window).
- Update the production service `DATABASE_URL` to `NEW_DATABASE_URL`.
- Roll the service (or redeploy) so all instances pick up the new connection.

### Step 5 — Post-cutover verification

- `GET /ready` returns OK
- Error rate and DB connection metrics remain normal
- Attachments still load (object storage reads should not depend on DB host)

Keep the old database around (read-only if possible) until you’re confident.

## Migration safety notes (zero downtime)

Prisma migrations can be zero-downtime *if* migrations are designed to be backwards compatible and deployed using an “expand/contract” approach.

### Principles

- Prefer **additive** changes (add column/table/index) over destructive changes.
- Avoid changing column types or dropping columns in the same deploy.
- Make application code backwards compatible during the transition.
- Only one actor should run migrations at a time.

### Deploying migrations safely (runbook)

This is the recommended sequence for production:

1) Pre-flight
- Ensure automated backups are healthy.
- Take a manual backup with [scripts/db/backup.sh](../scripts/db/backup.sh).

2) Expand (backwards compatible)
- Deploy code that can work with BOTH old and new schema.
  - Example: code writes to both `old_column` and `new_column`, and reads from `old_column` with fallback.

3) Apply migrations (once)

Run migrations from a one-off job / release step (not on every app instance):

- `DATABASE_URL=... scripts/db/migrate.sh`

PowerShell equivalent:

- `$env:DATABASE_URL='...'; powershell -ExecutionPolicy Bypass -File scripts/db/migrate.ps1`

What it does:

- Acquires a Postgres advisory lock so only one migrator runs
- Runs `npx prisma migrate deploy`

If your production start command already runs `prisma migrate deploy`, ensure you do not start multiple fresh instances simultaneously during a migration. Prefer running migrations explicitly via `scripts/db/migrate.sh` and then rolling out instances.

4) Contract (cleanup)
- After the app has been running successfully for some time:
  - Backfill data if needed
  - Switch reads/writes fully to the new schema
  - Only in a later deploy: drop old columns/tables

### Indexes and long-running migrations

- Creating indexes on large tables can lock writes depending on the operation.
- For truly zero downtime, you may need Postgres-native operations like `CREATE INDEX CONCURRENTLY`.
  - Prisma migrations can include raw SQL in migration files.

### Rollback strategy

- If an application deploy fails but the migration is backwards compatible: roll back the app code.
- If you need to roll back data/schema aggressively:
  - Restore the last known-good backup into a new DB
  - Cut over `DATABASE_URL` back to the restored DB

## Related docs

- Production checklist: [docs/production-checklist.md](production-checklist.md)
- Attachment migration (object storage): see “Migrate legacy disk uploads” in the production checklist
