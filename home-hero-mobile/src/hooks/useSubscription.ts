import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type SubscriptionInfo = {
  userId: number;
  role: string;
  tier: "FREE" | "BASIC" | "PRO";
  bidLimitPer30Days: number | null;
  bidsUsedLast30Days: number | null;
  remainingBids: number | null;
};

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
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSubscription = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await api.get<SubscriptionInfo>("/subscription");
      setSubscription(data);
    } catch (err: any) {
      setError(err?.message || "Failed to load subscription");
    } finally {
      setLoading(false);
    }
  }, []);

  const upgradeTier = useCallback(async (tier: "BASIC" | "PRO") => {
    try {
      const data = await api.post<SubscriptionInfo>("/subscription/upgrade", {
        tier,
      });
      setSubscription(data);
      return true;
    } catch (err: any) {
      throw err?.message || "Failed to upgrade subscription";
    }
  }, []);

  const downgradeTier = useCallback(async (tier: "FREE" | "BASIC") => {
    try {
      const data = await api.post<SubscriptionInfo>("/subscription/downgrade", {
        tier,
      });
      setSubscription(data);
      return true;
    } catch (err: any) {
      throw err?.message || "Failed to downgrade subscription";
    }
  }, []);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  return {
    subscription,
    loading,
    error,
    fetchSubscription,
    upgradeTier,
    downgradeTier,
    tierFeatures: TIER_FEATURES,
  };
}
