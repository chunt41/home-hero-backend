#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/db/backup.sh [--out <path>] [--no-gzip] [--include-drop]

Creates a logical Postgres backup using pg_dump.

Environment:
  DATABASE_URL           Connection string (preferred)
  or standard PG* envs (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT)

Options:
  --out <path>           Output file path. Default: backups/db-backup-<timestamp>.sql.gz
  --no-gzip              Write plain .sql (not gzipped)
  --include-drop         Include DROP statements in the dump (--clean --if-exists)

Notes:
  - This produces a plain SQL dump (psql-restorable).
  - For production restores, prefer restoring into a NEW database and cutting over.
EOF
}

OUT=""
GZIP=1
INCLUDE_DROP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --out)
      OUT="${2:-}"
      shift 2
      ;;
    --no-gzip)
      GZIP=0
      shift
      ;;
    --include-drop)
      INCLUDE_DROP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found. Install Postgres client tools." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" && -z "${PGDATABASE:-}" ]]; then
  echo "Missing database connection settings." >&2
  echo "Set DATABASE_URL or set PGDATABASE (and PGHOST/PGUSER/PGPASSWORD as needed)." >&2
  exit 2
fi

TS="$(date -u +%Y%m%d-%H%M%SZ)"
mkdir -p backups

if [[ -z "$OUT" ]]; then
  if [[ "$GZIP" -eq 1 ]]; then
    OUT="backups/db-backup-${TS}.sql.gz"
  else
    OUT="backups/db-backup-${TS}.sql"
  fi
fi

DUMP_ARGS=(
  "--no-owner"
  "--no-privileges"
  "--format=plain"
)

if [[ "$INCLUDE_DROP" -eq 1 ]]; then
  DUMP_ARGS+=("--clean" "--if-exists")
fi

echo "[backup] starting" >&2
echo "[backup] out=$OUT" >&2

CONN_ARGS=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  CONN_ARGS+=("$DATABASE_URL")
fi

if [[ "$GZIP" -eq 1 ]]; then
  if ! command -v gzip >/dev/null 2>&1; then
    echo "gzip not found. Install gzip or use --no-gzip." >&2
    exit 1
  fi

  pg_dump "${DUMP_ARGS[@]}" "${CONN_ARGS[@]}" | gzip -c > "$OUT"

  # best-effort integrity check
  gzip -t "$OUT"
else
  pg_dump "${DUMP_ARGS[@]}" "${CONN_ARGS[@]}" > "$OUT"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT" > "${OUT}.sha256"
  echo "[backup] wrote checksum ${OUT}.sha256" >&2
fi

echo "[backup] done" >&2
