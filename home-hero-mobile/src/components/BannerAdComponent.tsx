import React from "react";
import { View, StyleSheet } from "react-native";
import { NativeModules } from "react-native";

let BannerAd: any;
let BannerAdSize: any;

function hasGoogleMobileAdsNativeModule(): boolean {
  const proxy = (global as any)?.__turboModuleProxy;
  if (typeof proxy === "function") {
    try {
      return Boolean(proxy("RNGoogleMobileAdsModule"));
    } catch {
      return false;
    }
  }

  return Boolean((NativeModules as any)?.RNGoogleMobileAdsModule);
}

function ensureBannerAdsLoaded(): boolean {
  if (BannerAd && BannerAdSize) return true;
  if (!hasGoogleMobileAdsNativeModule()) return false;

  try {
    const gma = require("react-native-google-mobile-ads");
    BannerAd = gma.BannerAd;
    BannerAdSize = gma.BannerAdSize;
    return Boolean(BannerAd && BannerAdSize);
  } catch {
    return false;
  }
}

const PROD_DEFAULT_BANNER_UNIT_ID = "ca-app-pub-9932102016565081/9425093050"; // Android banner ad unit ID
const TEST_BANNER_UNIT_ID = "ca-app-pub-3940256099942544/6300978111"; // Google-provided test ID

const AD_KEYWORDS = [
  "tools",
  "power tools",
  "hand tools",
  "hardware",
  "home improvement",
  "diy",
  "workwear",
  "boots",
  "outdoor apparel",
  "outdoor gear",
  "camping",
  "hiking",
];

function parseUnitIds(raw: string | undefined | null): string[] {
  const useTestIds =
    (process.env.EXPO_PUBLIC_ADMOB_USE_TEST_IDS ?? "").trim() === "true";

  // In development builds, always use Google-provided test IDs.
  // Real AdMob units commonly return "no-fill" during development/testing.
  if (__DEV__ || useTestIds) return [TEST_BANNER_UNIT_ID];

  const s = String(raw ?? "").trim();
  if (!s) {
    return [PROD_DEFAULT_BANNER_UNIT_ID];
  }
  const parts = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length) return parts;
  return [PROD_DEFAULT_BANNER_UNIT_ID];
}

function pickUnitId(unitIds: string[], placementKey: string): string {
  if (unitIds.length === 1) return unitIds[0];
  // Deterministic-ish hash so each placement tends to use a different unit
  let hash = 0;
  for (let i = 0; i < placementKey.length; i++) {
    hash = (hash * 31 + placementKey.charCodeAt(i)) >>> 0;
  }
  return unitIds[hash % unitIds.length];
}

interface BannerAdComponentProps {
  style?: any;
  placement?: string;
}

export const BannerAdComponent: React.FC<BannerAdComponentProps> = ({
  style,
  placement,
}) => {
  const [adHeight, setAdHeight] = React.useState(0);

  const unitIds = parseUnitIds(process.env.EXPO_PUBLIC_ADMOB_BANNER_UNIT_IDS);
  const unitId = pickUnitId(unitIds, placement ?? "default");

  // If ads not available, show nothing
  if (!ensureBannerAdsLoaded() || !BannerAd) {
    return null;
  }

  return (
    <View style={[styles.adContainer, style]}>
      <BannerAd
        unitId={unitId}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{
          requestNonPersonalizedAdsOnly: false,
          keywords: AD_KEYWORDS,
          customTargeting: {
            vertical: "tools_outdoors",
          },
        }}
        onAdLoaded={() => setAdHeight(50)}
        onAdFailedToLoad={(error: unknown) =>
          console.log("Banner ad failed to load:", error)
        }
      />
    </View>
  );
};

const styles = StyleSheet.create({
  adContainer: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});
