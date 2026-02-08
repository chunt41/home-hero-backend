# Load testing (k6)

This repo includes lightweight k6 scripts for the most critical API endpoints.

## Scripts

Location: `loadtest/`

- `provider-search.k6.js` → `GET /providers/search`
- `job-post.k6.js` → `POST /jobs`
- `bid-placement.k6.js` → `POST /jobs/:id/bids` (creates a new job in `setup()` first)
- `message-send.k6.js` → `POST /jobs/:id/messages` (creates a new job in `setup()` first)
- `notifications-list.k6.js` → `GET /me/notifications`

## Prerequisites

- A target environment you’re OK writing test data into (these tests create jobs/messages/bids).
- Valid JWT auth tokens:
  - Consumer token: must be a **verified CONSUMER** user (required for `POST /jobs`, `POST /jobs/:id/messages`).
  - Provider token: must be a **verified PROVIDER** user (required for `POST /jobs/:id/bids`).

## Mint load-test JWTs (consumer + provider)

These endpoints exist in the backend:

- `POST /auth/signup` → returns a JWT immediately, but `emailVerified=false` initially
- `POST /auth/verify-email` → marks the user verified (requires the verification token)
- `POST /auth/login` → returns a JWT you can use for k6

### Local/dev (easy path)

In `NODE_ENV=development`, the backend prints a “DEV EMAIL” to stdout that includes a verify link like:

`/verify-email?token=...`

1) Sign up a consumer:

```bash
BASE=http://localhost:4000

curl -sS "$BASE/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"role":"CONSUMER","name":"Load Test Consumer","email":"loadtest-consumer@example.com","password":"ChangeMe123!"}'
```

2) Copy the token from the verify link printed in the server logs, then verify:

```bash
curl -sS "$BASE/auth/verify-email" \
  -H "Content-Type: application/json" \
  -d '{"token":"PASTE_VERIFY_TOKEN_HERE"}'
```

3) Log in and capture the JWT:

```bash
CONSUMER_JWT=$(curl -sS "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"loadtest-consumer@example.com","password":"ChangeMe123!"}' \
  | node -e "process.stdin.on('data',d=>{const j=JSON.parse(String(d)); process.stdout.write(j.token||'');})")
echo "$CONSUMER_JWT"
```

Repeat the same for a provider (change `role` + email):

```bash
curl -sS "$BASE/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"role":"PROVIDER","name":"Load Test Provider","email":"loadtest-provider@example.com","password":"ChangeMe123!"}'
```

Verify via the dev-email link, then:

```bash
PROVIDER_JWT=$(curl -sS "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"loadtest-provider@example.com","password":"ChangeMe123!"}' \
  | node -e "process.stdin.on('data',d=>{const j=JSON.parse(String(d)); process.stdout.write(j.token||'');})")
echo "$PROVIDER_JWT"
```

### Staging/prod-like environments

You have two options:

1) Configure a real email provider and complete verification using the emailed link, then `POST /auth/login`.
2) If you control the database and it’s appropriate for your staging environment, mark the test users as verified by setting `emailVerifiedAt` (then `POST /auth/login`).

### PowerShell snippets (Windows)

```powershell
$Base = "http://localhost:4000"

# Login and read JWT
$login = Invoke-RestMethod -Method Post -Uri "$Base/auth/login" -ContentType "application/json" -Body (@{
  email = "loadtest-consumer@example.com"
  password = "ChangeMe123!"
} | ConvertTo-Json)

$ConsumerJwt = $login.token
$ConsumerJwt
```

## Install k6 locally

- macOS: `brew install k6`
- Windows: `choco install k6` (or download from https://k6.io)
- Linux: see https://k6.io/docs/get-started/installation/

## Common env vars

All scripts support:

- `K6_BASE_URL` (default: `http://localhost:4000`)
- `K6_VUS` (default varies by script)
- `K6_DURATION` (default varies by script)
- `K6_SLEEP_SECONDS` (default: `0.2`)

Auth tokens:

- `K6_AUTH_TOKEN` (Bearer JWT) — used by scripts that only need one token
- `K6_CONSUMER_TOKEN` — used when the script must create a job in `setup()`
- `K6_PROVIDER_TOKEN` — used by bid placement

## Run locally

Provider search:

```bash
k6 run loadtest/provider-search.k6.js \
  -e K6_BASE_URL=http://localhost:4000 \
  -e K6_AUTH_TOKEN="$CONSUMER_JWT" \
  -e K6_SEARCH_ZIP=10001
```

Notifications list:

```bash
k6 run loadtest/notifications-list.k6.js \
  -e K6_BASE_URL=http://localhost:4000 \
  -e K6_AUTH_TOKEN="$CONSUMER_JWT"
```

Create jobs (writes data):

```bash
k6 run loadtest/job-post.k6.js \
  -e K6_BASE_URL=http://localhost:4000 \
  -e K6_AUTH_TOKEN="$CONSUMER_JWT" \
  -e K6_VUS=5 \
  -e K6_DURATION=30s
```

Bid placement (writes data; creates a job in setup):

```bash
k6 run loadtest/bid-placement.k6.js \
  -e K6_BASE_URL=http://localhost:4000 \
  -e K6_CONSUMER_TOKEN="$CONSUMER_JWT" \
  -e K6_PROVIDER_TOKEN="$PROVIDER_JWT" \
  -e K6_VUS=3 \
  -e K6_DURATION=30s
```

Message send (writes data; creates a job in setup):

```bash
k6 run loadtest/message-send.k6.js \
  -e K6_BASE_URL=http://localhost:4000 \
  -e K6_CONSUMER_TOKEN="$CONSUMER_JWT" \
  -e K6_VUS=3 \
  -e K6_DURATION=30s
```

## GitHub Actions (manual)

Workflow: `.github/workflows/k6-loadtests.yml`

- Trigger: **Actions → “k6 load tests (manual)” → Run workflow**
- Required inputs:
  - `target_url` (base URL)
- Required repository secrets:
  - `LOADTEST_CONSUMER_TOKEN`
  - `LOADTEST_PROVIDER_TOKEN`

Notes:

- This workflow is `workflow_dispatch` only and does **not** block normal CI.
- Use a staging environment; these tests create write traffic.
