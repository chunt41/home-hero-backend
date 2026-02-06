import type { ExpoConfig, ConfigContext } from "expo/config";

// NOTE:
// - AdMob *App IDs* must be baked into the native build config.
// - We keep safe defaults (Google test IDs) for local/dev.
// - For production builds, set these via EAS environment variables/secrets.

const GOOGLE_TEST_ADMOB_ANDROID_APP_ID = "ca-app-pub-3940256099942544~3347511713";
const GOOGLE_TEST_ADMOB_IOS_APP_ID = "ca-app-pub-3940256099942544~1458002511";

export default ({ config }: ConfigContext): ExpoConfig => {
  const androidAppId = (process.env.ADMOB_ANDROID_APP_ID ?? "").trim();
  const iosAppId = (process.env.ADMOB_IOS_APP_ID ?? "").trim();

  const next: any = {
    ...config,
    // Preserve any values from app.json and plugins
    extra: {
      ...(config.extra ?? {}),
    },
    plugins: [...(config.plugins ?? [])],
  };

  // react-native-google-mobile-ads config plugin
  const gmaPluginName = "react-native-google-mobile-ads";
  const gmaPlugin: any = [gmaPluginName, {
    androidAppId: androidAppId || GOOGLE_TEST_ADMOB_ANDROID_APP_ID,
    iosAppId: iosAppId || GOOGLE_TEST_ADMOB_IOS_APP_ID,
  }];

  const existingIndex = next.plugins.findIndex((p: any) => {
    if (typeof p === "string") return p === gmaPluginName;
    if (Array.isArray(p)) return p[0] === gmaPluginName;
    return false;
  });

  if (existingIndex >= 0) {
    next.plugins[existingIndex] = gmaPlugin;
  } else {
    next.plugins.push(gmaPlugin);
  }

  next.ios = {
    ...(next.ios ?? {}),
    infoPlist: {
      ...((next.ios as any)?.infoPlist ?? {}),
      NSCalendarsUsageDescription:
        ((next.ios as any)?.infoPlist?.NSCalendarsUsageDescription as string | undefined) ??
        "Home Hero would like to add appointments to your calendar.",
    },
  };

  next.android = {
    ...(next.android ?? {}),
    permissions: Array.from(
      new Set([
        ...(((next.android as any)?.permissions as string[] | undefined) ?? []),
        "READ_CALENDAR",
        "WRITE_CALENDAR",
      ])
    ),
  };

  return next as ExpoConfig;
};
