import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as SecureStore from "expo-secure-store";
import { api } from "../lib/apiClient";
import { useAuth } from "./AuthContext";

export type SubscriptionInfo = {
  userId: number;
  role: string;
  tier: "FREE" | "BASIC" | "PRO";
  bidLimitPer30Days: number | null;
  bidsUsedLast30Days: number | null;
  remainingBids: number | null;
};

type SubscriptionContextValue = {
  subscription: SubscriptionInfo | null;
  loading: boolean;
  error: string | null;
  fetchSubscription: () => Promise<void>;
  downgradeToTier: (tier: "FREE" | "BASIC") => Promise<void>;
  downgradeToFree: () => Promise<void>;
};

const SubscriptionContext = createContext<SubscriptionContextValue | null>(null);

const SUBSCRIPTION_CACHE_KEY = "homeHero.subscriptionCache";

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { token, isBooting } = useAuth();

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const fetchSubscription = useCallback(async () => {
    if (!token) {
      setSubscription(null);
      setError(null);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const data = await api.get<SubscriptionInfo>("/subscription");
      if (requestId !== requestIdRef.current) return;
      setSubscription(data);
      try {
        await SecureStore.setItemAsync(
          SUBSCRIPTION_CACHE_KEY,
          JSON.stringify({ cachedAt: Date.now(), data })
        );
      } catch {
        // ignore cache failures
      }
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      setError(err?.message || "Failed to load subscription");
    } finally {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
    }
  }, [token]);

  const downgradeToTier = useCallback(
    async (tier: "FREE" | "BASIC") => {
      if (!token) {
        throw new Error("Not authenticated");
      }

      await api.post("/subscription/downgrade", { tier });
      await fetchSubscription();
    },
    [token, fetchSubscription]
  );

  const downgradeToFree = useCallback(async () => {
    if (!token) {
      throw new Error("Not authenticated");
    }

    await downgradeToTier("FREE");
  }, [token, downgradeToTier]);

  // Refresh subscription when auth token becomes available.
  useEffect(() => {
    if (isBooting) return;
    if (!token) {
      setSubscription(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Hydrate from cache immediately to avoid UI flicker,
    // then refresh from server in the background.
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(SUBSCRIPTION_CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const cached = parsed?.data as SubscriptionInfo | undefined;
        if (cached?.tier) {
          setSubscription(cached);
        }
      } catch {
        // ignore cache parse errors
      }
    })();

    fetchSubscription();
  }, [token, isBooting, fetchSubscription]);

  const value = useMemo<SubscriptionContextValue>(
    () => ({
      subscription,
      loading,
      error,
      fetchSubscription,
      downgradeToTier,
      downgradeToFree,
    }),
    [subscription, loading, error, fetchSubscription, downgradeToTier, downgradeToFree]
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscriptionContext() {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) {
    throw new Error(
      "useSubscriptionContext must be used within a SubscriptionProvider"
    );
  }
  return ctx;
}
