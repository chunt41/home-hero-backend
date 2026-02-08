#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/db/restore.sh --file <backup.sql|backup.sql.gz> [--database-url <url>] --force

Restores a plain SQL dump into a Postgres database using psql.

Environment:
  DATABASE_URL            Used if --database-url not provided

Required:
  --force                 Acknowledge this is destructive for the target DB

Notes:
  - This script does NOT create the database. Create an empty target DB first.
  - For production restores, prefer restoring into a NEW database and cutting over.
EOF
}

FILE=""
TARGET_URL=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --file)
      FILE="${2:-}"
      shift 2
      ;;
    --database-url)
      TARGET_URL="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$FILE" ]]; then
  echo "Missing --file" >&2
  usage >&2
  exit 2
fi

if [[ ! -f "$FILE" ]]; then
  echo "Backup file not found: $FILE" >&2
  exit 1
fi

if [[ -z "$TARGET_URL" ]]; then
  TARGET_URL="${DATABASE_URL:-}"
fi

if [[ -z "$TARGET_URL" ]]; then
  echo "Missing target DB URL. Set DATABASE_URL or pass --database-url." >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install Postgres client tools." >&2
  exit 1
fi

if [[ "$FORCE" -ne 1 ]]; then
  echo "Refusing to restore without --force (this can overwrite the target DB)." >&2
  exit 2
fi

echo "[restore] starting" >&2
echo "[restore] file=$FILE" >&2

echo "[restore] testing connection" >&2
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 1;" >/dev/null

echo "[restore] restoring..." >&2
if [[ "$FILE" == *.gz ]]; then
  if ! command -v gzip >/dev/null 2>&1; then
    echo "gzip not found. Install gzip to restore .gz backups." >&2
    exit 1
  fi
  gzip -dc "$FILE" | psql "$TARGET_URL" -v ON_ERROR_STOP=1
else
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$FILE"
fi

echo "[restore] verifying DB responds" >&2
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -tAc "SELECT now();" >/dev/null

echo "[restore] done" >&2
