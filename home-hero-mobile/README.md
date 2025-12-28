# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Ads configuration

This app uses `react-native-google-mobile-ads`.

- Banner ads: set `EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS` (comma-separated) to rotate between multiple banner unit IDs.
   - Example (single unit):
      - `EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS=ca-app-pub-9932102016565081/9425093050`
   - Example (multiple units for more variety):
      - `EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS=unitA,unitB,unitC`
- Interstitial ads: globally gated by `EXPO_PUBLIC_ENABLE_INTERSTITIAL_ADS`.
   - `false` disables interstitials entirely.
   - `true` enables interstitials for FREE tier only.

Additional env vars:
- `EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID` (optional override for the interstitial unit).
- `EXPO_PUBLIC_ADMOB_USE_TEST_IDS=true` forces Google test ad unit IDs.

Build-time AdMob App IDs (native config):
- Set `ADMOB_ANDROID_APP_ID` and/or `ADMOB_IOS_APP_ID` via EAS environment variables/secrets.
- If omitted, dev/test builds fall back to Google test App IDs.

Tip: if you still see repetitive ads with a single banner unit ID, that’s usually AdMob inventory/targeting. Creating multiple banner ad units (and/or enabling mediation in AdMob) is the most reliable way to increase variety.

## Payments configuration

This app uses `@stripe/stripe-react-native`.

- Local/dev: set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` in your `.env` to enable Stripe PaymentSheet.
- Production (EAS builds): set `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS project secret so it’s available on remote builders.
   - Helper script (Windows PowerShell): `./scripts/setup-eas-production.ps1`

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
