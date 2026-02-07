# Deployment Gate

This repo has a **deployment gate**: a small, explicit set of checks that must pass before deploying.

## One-command verification

Run:

- `npm run verify:gate`

This command is designed to be deterministic and to fail fast.

## The 7 gate items

1. **TypeScript typecheck**
   - Runs `tsc -p tsconfig.json --noEmit`

2. **Production startup validation: Redis rate limit config**
   - Enforced by tests in `src/productionReadiness/**`.

3. **Production startup validation: object storage config**
   - Enforced by tests in `src/productionReadiness/**`.

4. **Production startup validation: Stripe webhook config**
   - Enforced by tests in `src/productionReadiness/**`.

5. **Production startup validation: attestation enforcement config**
   - Enforced by tests in `src/productionReadiness/**`.

6. **Core safety + reliability suites**
   - Webhook idempotency: `src/services/stripeServiceWebhookIdempotency.test.ts`, `src/routes/paymentsWebhookIdempotency.test.ts`
   - Provider search endpoint: `src/routes/providersSearch.test.ts`
   - Contact exchange gate: `src/routes/contactExchange.test.ts`
   - Anti-scam / moderation: `src/services/jobMessageSendModeration.test.ts`, `src/services/riskScoring.messageModeration.test.ts`

7. **Push token cleanup / Expo sender self-healing**
   - `src/services/expoPush.test.ts`

## CI

CI runs the exact same command (`npm run verify:gate`). If the gate fails, deployment should be blocked.
