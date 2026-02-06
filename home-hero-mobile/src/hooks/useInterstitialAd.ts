import { useCallback, useRef, useEffect } from "react";
import { NativeModules } from "react-native";

let InterstitialAd: any;
let AdEventType: any;

function hasGoogleMobileAdsNativeModule(): boolean {
  // When running in Expo Go / a dev client without the native module,
  // requiring react-native-google-mobile-ads will crash. Guard first.
  //
  // On RN New Architecture (TurboModules), prefer __turboModuleProxy.
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

function ensureGoogleMobileAdsLoaded(): boolean {
  if (InterstitialAd && AdEventType) return true;
  if (!hasGoogleMobileAdsNativeModule()) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gma = require("react-native-google-mobile-ads");
    InterstitialAd = gma.InterstitialAd;
    AdEventType = gma.AdEventType;
    return Boolean(InterstitialAd && AdEventType);
  } catch {
    return false;
  }
}

const PROD_DEFAULT_INTERSTITIAL_UNIT_ID =
  "ca-app-pub-9932102016565081/4723430710"; // Android interstitial ad unit ID
const TEST_INTERSTITIAL_UNIT_ID = "ca-app-pub-3940256099942544/1033173712"; // Google-provided test ID

function getInterstitialUnitId(): string {
  const envId = (process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_UNIT_ID ?? "").trim();
  if (envId) return envId;

  const useTestIds =
    (process.env.EXPO_PUBLIC_ADMOB_USE_TEST_IDS ?? "").trim() === "true";
  if (__DEV__ || useTestIds) return TEST_INTERSTITIAL_UNIT_ID;

  return PROD_DEFAULT_INTERSTITIAL_UNIT_ID;
}

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

export function useInterstitialAd(enabled: boolean = true) {
  const adRef = useRef<any>(null);
  const isLoadingRef = useRef(false);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      adRef.current = null;
      isLoadingRef.current = false;
    }
  }, [enabled]);

  const loadAd = useCallback(async () => {
    if (!enabledRef.current) return;

    // Lazy-load Google Mobile Ads only when needed.
    if (!ensureGoogleMobileAdsLoaded()) {
      return;
    }

    if (!InterstitialAd || isLoadingRef.current || adRef.current) {
      return;
    }

    isLoadingRef.current = true;

    try {
      const ad = InterstitialAd.createForAdRequest(getInterstitialUnitId(), {
        keywords: AD_KEYWORDS,
        requestNonPersonalizedAdsOnly: false,
        customTargeting: {
          vertical: "tools_outdoors",
        },
      });

      // Subscribe to ad events
      ad.addAdEventListener(AdEventType.LOADED, () => {
        console.log("Interstitial ad loaded");
        adRef.current = ad;
        isLoadingRef.current = false;
      });

      ad.addAdEventListener(AdEventType.CLOSED, () => {
        console.log("Interstitial ad closed");
        adRef.current = null;
        // Reload for next time
        setTimeout(() => loadAd(), 5000);
      });

      // @ts-ignore
      ad.addAdEventListener(AdEventType.ERROR, (error: any) => {
        console.log("Interstitial ad error:", error);
        adRef.current = null;
        isLoadingRef.current = false;
      });

      // Load the ad
      await ad.load();
    } catch (error) {
      console.error("Error loading interstitial ad:", error);
      isLoadingRef.current = false;
    }
  }, []);

  const showAd = useCallback(async () => {
    if (!enabledRef.current) return;
    if (!ensureGoogleMobileAdsLoaded() || !InterstitialAd) {
      console.log("Interstitial ads not available");
      return;
    }
    if (adRef.current) {
      try {
        await adRef.current.show();
      } catch (error) {
        console.error("Error showing interstitial ad:", error);
        // Reload for next time
        loadAd();
      }
    } else {
      // Ad not ready, load it first
      await loadAd();
    }
  }, [loadAd]);

  // Auto-load ad on mount
  useEffect(() => {
    if (!enabled) return;
    loadAd();
  }, [enabled, loadAd]);

  return { showAd, isReady: !!adRef.current };
}
