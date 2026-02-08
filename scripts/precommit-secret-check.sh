#!/usr/bin/env bash
set -euo pipefail

# Optional pre-commit hook: blocks obvious secrets and forbidden filenames.
# Enable (from repo root):
#   ln -s ../../scripts/precommit-secret-check.sh .git/hooks/pre-commit
# Or copy it:
#   cp scripts/precommit-secret-check.sh .git/hooks/pre-commit
#
# Windows users: run from Git Bash.

FORBIDDEN_NAME_RE='(^|/)(\.env(\..*)?|.*\.(pem|p12|key)|.*service[_-]?account.*\.json|google-credentials\.json|google-service-account.*\.json|service-account.*\.json)$'

# 1) Reject forbidden filenames in the staged set
staged_files=$(git diff --cached --name-only --diff-filter=ACMRT || true)

if [[ -n "${staged_files}" ]]; then
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    if [[ "${f}" =~ ${FORBIDDEN_NAME_RE} ]]; then
      echo "ERROR: refusing to commit forbidden file: ${f}" >&2
      echo "Hint: add it to .gitignore and keep secrets in your secret manager." >&2
      exit 1
    fi
  done <<< "${staged_files}"
fi

# 2) Reject obvious secret patterns in staged content
# We scan the staged blob, not the working tree.
SECRET_PATTERNS=(
  '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'xox[baprs]-[0-9A-Za-z-]+'
  'sk_live_[0-9a-zA-Z]+'
  'rk_live_[0-9a-zA-Z]+'
  'whsec_[0-9a-zA-Z]+'
  'AIza[0-9A-Za-z\-_]{35}'
  'BEGIN PGP PRIVATE KEY BLOCK'
  'password\s*[:=]\s*[^\s]+'
  'secret\s*[:=]\s*[^\s]+'
)

fail=0

if [[ -n "${staged_files}" ]]; then
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue

    # Only scan text-like files (skip large/binary by using git attributes heuristics)
    # If git thinks it's binary, skip content scanning.
    if git show ":${f}" | LC_ALL=C grep -q $'\x00'; then
      continue
    fi

    content=$(git show ":${f}" 2>/dev/null || true)
    if [[ -z "${content}" ]]; then
      continue
    fi

    for re in "${SECRET_PATTERNS[@]}"; do
      if echo "${content}" | grep -E -n --color=never "${re}" >/dev/null 2>&1; then
        echo "ERROR: potential secret detected in staged file: ${f}" >&2
        echo "Matched pattern: ${re}" >&2
        fail=1
        break
      fi
    done
  done <<< "${staged_files}"
fi

if [[ "${fail}" -ne 0 ]]; then
  echo "Refusing commit. Remove the secret, rotate credentials, and try again." >&2
  exit 1
fi

exit 0
