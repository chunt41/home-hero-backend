#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/db/migrate.sh [--database-url <url>] [--no-lock]

Safely runs Prisma production migrations with a Postgres advisory lock
(so only one instance runs migrations at a time).

Environment:
  DATABASE_URL            Used if --database-url not provided

Notes:
  - Uses `prisma migrate deploy` (safe for production; applies existing migrations).
  - Do NOT use `prisma migrate dev` in production.
EOF
}

TARGET_URL=""
NO_LOCK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --database-url)
      TARGET_URL="${2:-}"
      shift 2
      ;;
    --no-lock)
      NO_LOCK=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET_URL" ]]; then
  TARGET_URL="${DATABASE_URL:-}"
fi

if [[ -z "$TARGET_URL" ]]; then
  echo "Missing DB URL. Set DATABASE_URL or pass --database-url." >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install Postgres client tools." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not found. Install Node.js/npm." >&2
  exit 1
fi

LOCK_KEY_SQL="hashtext('home-hero-backend-prisma-migrate')"
LOCK_ACQUIRED=0

unlock() {
  if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    echo "[migrate] releasing advisory lock" >&2
    psql "$TARGET_URL" -v ON_ERROR_STOP=1 -tAc "SELECT pg_advisory_unlock(${LOCK_KEY_SQL});" >/dev/null || true
  fi
}
trap unlock EXIT

if [[ "$NO_LOCK" -ne 1 ]]; then
  echo "[migrate] acquiring advisory lock" >&2
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -tAc "SELECT pg_advisory_lock(${LOCK_KEY_SQL});" >/dev/null
  LOCK_ACQUIRED=1
else
  echo "[migrate] --no-lock set; skipping advisory lock" >&2
fi

echo "[migrate] prisma migrate status (pre)" >&2
npx prisma migrate status

echo "[migrate] prisma migrate deploy" >&2
npx prisma migrate deploy

echo "[migrate] prisma migrate status (post)" >&2
npx prisma migrate status

echo "[migrate] done" >&2
