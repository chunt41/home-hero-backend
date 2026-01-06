import { useSubscriptionContext, type SubscriptionInfo } from "../context/SubscriptionContext";

const TIER_FEATURES = {
  FREE: {
    price: "$0",
    billing: "Forever free",
    bidsPerMonth: 5,
    features: [
      "5 bids per month",
      "Basic profile",
      "Job browsing",
      "No priority support",
    ],
  },
  BASIC: {
    price: "$6",
    billing: "/month",
    bidsPerMonth: 100,
    features: [
      "100 bids per month",
      "Enhanced profile",
      "Job browsing & messaging",
      "Email support",
      "Access to job insights",
    ],
  },
  PRO: {
    price: "$12",
    billing: "/month",
    bidsPerMonth: "Unlimited",
    features: [
      "Unlimited bids",
      "Premium profile",
      "Priority job access",
      "24/7 priority support",
      "Advanced analytics",
      "Custom branding",
    ],
  },
};

export function useSubscription() {
  const { subscription, loading, error, fetchSubscription, downgradeToTier } =
    useSubscriptionContext();

  const downgradeTier = async (tier: "FREE" | "BASIC") => {
    await downgradeToTier(tier);
    return true;
  };

  return {
    subscription,
    loading,
    error,
    fetchSubscription,
    downgradeTier,
    tierFeatures: TIER_FEATURES,
  };
}
