# Security

This repository uses automated security scans in GitHub Actions.

## What runs in CI

All security workflows run on:

- `pull_request` targeting `main`
- `push` to `main`

### 1) CodeQL (SAST)

Workflow: `.github/workflows/codeql.yml`

- Runs CodeQL analysis for JavaScript/TypeScript using the **default query suite**.
- Results are uploaded to the repo’s **Security** tab (Code scanning alerts).

If CodeQL finds issues, alerts appear in GitHub Security. Depending on repo settings, findings may block merging.

### 2) Dependency scanning (npm audit)

Workflow: `.github/workflows/dependency-audit.yml`

- Runs `npm audit` and **fails CI** when vulnerabilities are at or above a configurable severity.
- Configure severity via GitHub Actions variable `NPM_AUDIT_LEVEL`:
  - Allowed values: `low` | `moderate` | `high` | `critical`
  - Default: `high`

### 3) Secret scanning (gitleaks)

Workflow: `.github/workflows/gitleaks.yml`

Config: `.gitleaks.toml`

- Runs `gitleaks` on PRs and pushes to `main`.
- CI **fails** if gitleaks detects potential secrets.

The repo includes a small allowlist for known-safe placeholders (example keys / CI dummy values). Do not add broad path ignores; prefer narrowly allowlisting specific placeholder patterns.

## Repository secret hygiene (local + CI)

This repo has **mandatory CI protections** and an **optional local hook** to reduce accidental secret commits.

### Git ignore + attributes

- `.gitignore` ignores `.env*` (except `.env.example`) and common key/service-account files.
- `.gitattributes` marks common secret file patterns as `export-ignore` so they are excluded from source archives.

Note: `.gitattributes` cannot prevent commits by itself; it complements `.gitignore` + hooks + CI.

### Optional pre-commit hook

Script: `scripts/precommit-secret-check.sh`

It rejects commits when:

- A forbidden filename is staged (e.g. `.env`, `*.pem`, `*.p12`, `*.key`, `*service-account*.json`)
- Staged content matches simple secret regexes (private key headers, `sk_live_...`, `whsec_...`, etc.)

Enable it:

- `ln -s ../../scripts/precommit-secret-check.sh .git/hooks/pre-commit`

Windows note: run the enable command from Git Bash.

## Handling findings

### CodeQL findings

- Open the alert in GitHub → Security → Code scanning.
- Fix the root cause; add tests where reasonable.
- If an alert is a false positive, document rationale and use GitHub’s dismissal reason.

### npm audit findings

- Prefer updating dependencies (direct or transitive).
- If a vulnerability is not applicable (e.g., dev-only tooling in production), document why and consider narrowing the gate severity via `NPM_AUDIT_LEVEL` only if needed.

### gitleaks findings

Treat as a real secret until proven otherwise:

1. Identify the leaked value and where it appears.
2. **Revoke/rotate** the credential immediately.
3. Remove the secret from the repo (including history if needed).
4. Add/adjust scanning allowlist rules only when you have strong justification.

## Anti-scam messaging controls

This backend includes production anti-scam controls for in-app job messaging.

### Deterministic detection (hard block)

Messages are deterministically scanned for:

- Phone numbers
- Email addresses
- Telegram / WhatsApp
- Off-platform payment prompts (e.g. gift cards, wire transfers, crypto, Zelle, Cash App, Venmo, PayPal)

These patterns are **hard-blocked** unless either:

- the job status is **AWARDED or later**, or
- **contact exchange** is approved for the job

User-facing errors are designed to be friendly and direct users to **Request contact exchange**.

### Repeat offender restriction

If a user triggers **3 blocked messages within 10 minutes**, messaging is temporarily restricted for **30 minutes**.

- A `SecurityEvent` is recorded for the block and for the restriction.
- The user risk score is increased to surface repeat offenders to admin tooling.

### Security events

Key `SecurityEvent.actionType` values emitted by the messaging pipeline:

- `message.blocked`
- `message.offplatform_allowed` (allowed due to awarded/approved contact exchange)
- `user.restricted` (repeat-offender restriction or risk-threshold restriction)

Event metadata is scrubbed to avoid storing secrets/tokens.

### Admin queue endpoint

Admins can review repeated violators via:

- `GET /admin/messages/violations?windowMinutes=10&minBlocks=3&limit=50`

This endpoint aggregates `message.blocked` events within the requested window and returns user details for moderation workflows.

## AI margin protection (quotas + model routing)

This backend includes guardrails to keep AI features profitable (especially at the $15 PRO tier).

### Tier default quotas (central config)

Tier defaults are centrally defined in [src/ai/aiConfig.ts](src/ai/aiConfig.ts):

- FREE: `0` tokens / month
- BASIC: `2000` tokens / month
- PRO: `5000` tokens / month

Operators can override defaults via env vars:

- `AI_TOKENS_LIMIT_FREE`
- `AI_TOKENS_LIMIT_BASIC`
- `AI_TOKENS_LIMIT_PRO`

### Cache-first behavior

The AI gateway is cache-first: a cache hit returns immediately and **never** consumes monthly quota.

### Cheap-by-default model selection

Model routing is cheap-by-default: the premium model is only used for explicitly allowlisted “high value” tasks *and* only for PRO users.

The premium allowlist is centrally defined in [src/ai/aiConfig.ts](src/ai/aiConfig.ts).

### Telemetry (SecurityEvent)

The gateway emits `SecurityEvent.actionType` values for ops visibility:

- `ai.cache_hit`
- `ai.provider_call`
- `ai.blocked_quota`
- `ai.user_monthly_threshold_exceeded` (see alerts below)

Note: `SecurityEvent` metadata is scrubbed to avoid storing secrets/tokens.

### Admin metrics endpoint

Admins can query aggregate AI usage via:

- `GET /admin/ai/metrics`

Returns:

- `tokensUsedPerTier`
- `cacheHitRatio`
- `topCostUsers` (ranked by tokens used)
- `blockedCallsCount`

### Monthly heavy-user alert

Set `AI_MONTHLY_USER_ALERT_THRESHOLD_TOKENS` to emit an alert when a single user crosses a monthly token threshold.

Behavior:

- Logs one `SecurityEvent` (`ai.user_monthly_threshold_exceeded`) per user per UTC month (first crossing only).
- Emits a Sentry warning (if `SENTRY_DSN` is configured).

## Admin operational UIs (web)

This backend serves a small number of **single-file HTML admin dashboards** (no separate frontend build) intended for rapid ops triage.

### Routes

- `GET /admin/webhooks/ui` — inspect webhook deliveries/attempts
- `GET /admin/ops/ui` — ops dashboard (flagged queue, disputes, webhook failures, KPIs)

### Security model

- **Feature gate**: both routes return `404` unless `ADMIN_UI_ENABLED=true`.
- **Production-only Basic Auth**: when `NODE_ENV=production`, the routes require Basic Auth with `ADMIN_UI_BASIC_USER`/`ADMIN_UI_BASIC_PASS`.
  - If credentials are not set in production, the route fails closed (returns `404`).
- **CSP + clickjacking hardening**: both HTML routes set a route-specific CSP to allow inline JS/CSS for the single-file UI and set `X-Frame-Options: DENY`.
- **Admin authorization for actions**: the UI pages require an **Admin JWT** (stored client-side in the browser) and call admin-only JSON endpoints using `Authorization: Bearer <token>`.

### Audit logging

All one-click moderation actions are audit-logged:

- `AdminAction` rows capture admin actions (e.g. suspend user, hide job/message).
- `SecurityEvent` records capture security/audit events (metadata scrubbed to avoid storing secrets/tokens).

If you add new admin actions, ensure they emit at least one `SecurityEvent` (and ideally an `AdminAction` when it represents a privileged admin operation).

## Reporting a security issue

If you believe you’ve found a security issue:

- Do not open a public issue with sensitive details.
- Contact the maintainers through the appropriate private channel for this project.
