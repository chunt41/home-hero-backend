import { useSubscription } from "./useSubscription";

export type AdConfig = {
  showBannerAds: boolean;
  showInterstitialAds: boolean;
};

export function useAdConfig(): AdConfig {
  const { subscription } = useSubscription();

  const tier = subscription?.tier || "FREE";

  return {
    showBannerAds: tier !== "PRO", // Banner ads for FREE and BASIC
    showInterstitialAds: tier === "FREE", // Interstitial ads only for FREE
  };
}
