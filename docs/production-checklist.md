# Production Checklist (Stripe + AdMob)

## Stripe (Live)

### 1) Environment variables (Railway)
Set these on the Railway service (do **not** commit to git):

- `DATABASE_URL`
- `JWT_SECRET`
- `STRIPE_SECRET_KEY` (must be `sk_live_...`)
- `STRIPE_WEBHOOK_SECRET` (must be `whsec_...`)
- `CORS_ORIGINS` (your real origins, comma-separated)

### 2) Stripe webhook endpoint
In Stripe Dashboard (Live mode):

- Developers → Webhooks → **Add endpoint**
- Endpoint URL:
  - `https://home-hero-backend-production.up.railway.app/payments/webhook`
- Events to send:
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`

Copy the signing secret (`whsec_...`) into Railway as `STRIPE_WEBHOOK_SECRET`.

### 3) Verify in production
After deploying, call the admin-only endpoint:

- `GET /payments/health`

It should return `ok: true`, `stripeOk: true`, and `stripeMode: "live"`.

## AdMob (Production builds via EAS)

### 1) Build-time AdMob App IDs (native config)
These are required by the native SDK and must be present at build time.

Set as EAS secrets:

- `ADMOB_ANDROID_APP_ID` (your AdMob **App** ID)
- `ADMOB_IOS_APP_ID` (optional if shipping iOS)

### 2) Runtime ad unit IDs (Expo public)
These are bundled into the JS at build time.

Set for EAS production builds:

- `EXPO_PUBLIC_API_BASE_URL=https://home-hero-backend-production.up.railway.app`
- `EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS=...` (comma-separated)
- `EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID=...` (optional)

Make sure `EXPO_PUBLIC_ADMOB_USE_TEST_IDS` is not `true` in production.

## Notes
- Keep `.env` local only; use Railway/EAS for production secrets.
- Rotate any keys that were ever pasted into chat/logs.
