import { useCallback, useRef, useEffect } from "react";

let InterstitialAd: any;
let AdEventType: any;

try {
  const gma = require("react-native-google-mobile-ads");
  InterstitialAd = gma.InterstitialAd;
  AdEventType = gma.AdEventType;
} catch (e) {
  // Google Mobile Ads not available (e.g., in Expo Go)
  console.log("Google Mobile Ads not available");
}

const AD_UNIT_ID = "ca-app-pub-9932102016565081/4723430710"; // Android interstitial ad unit ID

export function useInterstitialAd() {
  const adRef = useRef<any>(null);
  const isLoadingRef = useRef(false);

  const loadAd = useCallback(async () => {
    if (!InterstitialAd || isLoadingRef.current || adRef.current) {
      return;
    }

    isLoadingRef.current = true;

    try {
      const ad = InterstitialAd.createForAdRequest(AD_UNIT_ID, {
        keywords: ["jobs", "services", "marketplace"],
        requestNonPersonalizedAdsOnly: false,
      });

      // Subscribe to ad events
      const unsubscribe = ad.addAdEventListener(AdEventType.LOADED, () => {
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
    if (!InterstitialAd) {
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
    loadAd();
  }, [loadAd]);

  return { showAd, isReady: !!adRef.current };
}
