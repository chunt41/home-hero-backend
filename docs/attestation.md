# App attestation (defense in depth)

Home Hero supports **optional app attestation** as a defense-in-depth control.

- Default: `APP_ATTESTATION_ENFORCE=false`
- Scope: enforcement is applied only to **sensitive routes** (writes + auth flows), not all API reads.

This is intentionally designed so a deployment cannot accidentally brick users.

## What it protects against

Attestation helps reduce abuse from:

- **Scripted / automated clients** calling sensitive endpoints (signup/login/job creation, bidding, messaging, payments)
- **Some classes of API scraping** where the attacker is not running a legitimate app environment
- **Replay and basic tampering signals**, when platform verifiers are configured (nonce checks, package/bundle checks)

It is most effective when combined with:

- rate limiting + anomaly detection
- account verification (email verification)
- risk scoring and moderation rules

## What it does NOT protect against

Attestation is not a silver bullet. It does not fully prevent:

- **Stolen credentials** / account takeover (valid users can still authenticate)
- **Compromised devices** (rooted/jailbroken devices may bypass some checks)
- **Reverse engineered clients** that can produce valid-looking attestations
- **Insider threats** or valid API clients used maliciously
- **Fraud and scams** that happen within allowed workflows

Treat it as one control in a layered security posture.

## Safe defaults

- Enforcement defaults **OFF** unless explicitly enabled via `APP_ATTESTATION_ENFORCE=true`.
- In production, the startup env validator emits a warning if `APP_ATTESTATION_ENFORCE` is not set (so enforcement can’t be silently disabled by omission).
- If enforcement is ON in production and verifier configuration is missing, startup fails fast (to avoid “enabled but broken” deployments).

## Enforcement scope

Enforcement is scoped to sensitive routes only via [src/attestation/enforceAttestationForSensitiveRoutes.ts](src/attestation/enforceAttestationForSensitiveRoutes.ts).

This keeps read-only endpoints (e.g. browsing/search) accessible even during rollout.

## Rollout plan (recommended)

1) **Phase 0 — Observe (default)**
   - Keep `APP_ATTESTATION_ENFORCE=false`.
   - Ensure clients send `X-App-Platform` and `X-App-Attestation` headers.
   - Monitor audit events:
     - `attestation.missing`
     - `attestation.failed`

2) **Phase 1 — Enable on staging**
   - Set `APP_ATTESTATION_ENFORCE=true` in staging.
   - Validate verifier configuration and client behavior.

3) **Phase 2 — Limited production enforcement**
   - Enable `APP_ATTESTATION_ENFORCE=true` in production during a controlled window.
   - Keep enforcement limited to sensitive routes (already scoped).
   - Watch error rates / support volume; be ready to roll back by setting `APP_ATTESTATION_ENFORCE=false`.

4) **Phase 3 — Iterate**
   - Expand/verifier hardening (nonce binding, stronger device identifiers, stricter risk gating).

## Audit logging (no tokens stored)

The attestation middleware logs audit/security events on failures **without storing the token**:

- Missing token → `attestation.missing`
- Verification failure → `attestation.failed`

Metadata includes route + platform + reason code when available, but is scrubbed to avoid secrets.

## Headers

Clients should send:

- `X-App-Platform: android | ios`
- `X-App-Attestation: <token>`
- Optional: `X-App-Attestation-Nonce: <nonce>` (when verifiers use nonce binding)
