import { useAuth } from "../context/AuthContext";
import { useSubscription } from "./useSubscription";

export type AdConfig = {
  tier: "FREE" | "BASIC" | "PRO";
  showBannerAds: boolean;
  showInterstitialAds: boolean;
  inlineBannerEvery: number | null;
  showFooterBanner: boolean;
};

export function useAdConfig(): AdConfig {
  const { user } = useAuth();
  const { subscription } = useSubscription();

  const tier = subscription?.tier || "FREE";
  // Interstitials are disabled app-wide.
  // (If we ever re-enable them, do it intentionally and role/tier-aware.)
  const showInterstitialAds = false;

  // Consumers: always a single banner while browsing jobs.
  // Providers: ads based on tier.
  // Admin: no ads.
  if (user?.role === "CONSUMER") {
    return {
      tier,
      showBannerAds: true,
      showInterstitialAds,
      inlineBannerEvery: null,
      showFooterBanner: false,
    };
  }

  if (user?.role === "ADMIN") {
    return {
      tier,
      showBannerAds: false,
      showInterstitialAds,
      inlineBannerEvery: null,
      showFooterBanner: false,
    };
  }

  const showBannerAds = tier !== "PRO";

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
