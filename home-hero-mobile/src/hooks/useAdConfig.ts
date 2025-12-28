import { useSubscription } from "./useSubscription";

export type AdConfig = {
  tier: "FREE" | "BASIC" | "PRO";
  showBannerAds: boolean;
  showInterstitialAds: boolean;
  inlineBannerEvery: number | null;
  showFooterBanner: boolean;
};

export function useAdConfig(): AdConfig {
  const { subscription } = useSubscription();

  const tier = subscription?.tier || "FREE";
  const enableInterstitials =
    String(process.env.EXPO_PUBLIC_ENABLE_INTERSTITIAL_ADS ?? "false") ===
    "true";

  const showBannerAds = tier !== "PRO";
  const showInterstitialAds = enableInterstitials && tier === "FREE";

  // Banner density:
  // - FREE: frequent inline + footer
  // - BASIC: few ads (footer only)
  // - PRO: none
  const inlineBannerEvery = tier === "FREE" ? 3 : null;
  const showFooterBanner = tier === "FREE" || tier === "BASIC";

  return {
    tier,
    showBannerAds,
    showInterstitialAds,
    inlineBannerEvery,
    showFooterBanner,
  };
}
