import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type PaymentRecord = {
  id: string;
  amount: number;
  tier: string;
  status: string;
  createdAt: string;
};

export type AdRevenueRecord = {
  id: string;
  adFormat: string;
  revenue: number;
  impressions: number;
  clicks: number;
  date: string;
};

export type PayoutRecord = {
  id: string;
  type: string; // "subscription" | "ad_revenue"
  amount: number;
  status: string;
  description?: string;
  createdAt: string;
  paidAt?: string;
};

export type CombinedEarnings = {
  totalSubscriptionRevenue: number;
  totalAdRevenue: number;
  totalEarnings: number;
  monthlyBreakdown: {
    month: string;
    subscriptions: number;
    ads: number;
    total: number;
  }[];
  paymentHistory: PaymentRecord[];
  adRevenueHistory: AdRevenueRecord[];
  payoutHistory: PayoutRecord[];
  pendingPayout: number;
};

export function useCombinedEarnings() {
  const [earnings, setEarnings] = useState<CombinedEarnings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEarnings = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch all three data sources in parallel
      const [paymentsRes, adRevenueRes, payoutsRes] = await Promise.all([
        api.get<{ recentPayments: PaymentRecord[] }>("/payments/subscription/me").catch(() => ({ recentPayments: [] })),
        api.get<{ history: AdRevenueRecord[] }>("/ad-revenue/history/me?limit=100").catch(() => ({ history: [] })),
        api.get<PayoutRecord[]>("/payouts/me").catch(() => []),
      ]);

      const payments = paymentsRes?.recentPayments || [];
      const adRevenue = adRevenueRes?.history || [];
      const payouts = payoutsRes || [];

      // Calculate totals
      const totalSubscriptions = payments.reduce(
        (sum, p) => (p.status === "SUCCEEDED" ? sum + p.amount / 100 : sum),
        0
      );
      const totalAds = adRevenue.reduce((sum, a) => sum + Number(a.revenue), 0);

      // Group by month for breakdown
      const monthlyMap = new Map<string, { subscriptions: number; ads: number }>();

      payments.forEach((p) => {
        if (p.status === "SUCCEEDED") {
          const month = new Date(p.createdAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
          });
          if (!monthlyMap.has(month)) {
            monthlyMap.set(month, { subscriptions: 0, ads: 0 });
          }
          const m = monthlyMap.get(month)!;
          m.subscriptions += p.amount / 100;
        }
      });

      adRevenue.forEach((a) => {
        const month = new Date(a.date).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
        });
        if (!monthlyMap.has(month)) {
          monthlyMap.set(month, { subscriptions: 0, ads: 0 });
        }
        const m = monthlyMap.get(month)!;
        m.ads += Number(a.revenue);
      });

      const monthlyBreakdown = Array.from(monthlyMap.entries())
        .map(([month, data]) => ({
          month,
          subscriptions: data.subscriptions,
          ads: data.ads,
          total: data.subscriptions + data.ads,
        }))
        .sort(
          (a, b) =>
            new Date(b.month).getTime() - new Date(a.month).getTime()
        );

      // Calculate pending payout (unpaid earnings)
      const pendingPayout = payouts
        .filter((p) => p.status === "pending")
        .reduce((sum, p) => sum + Number(p.amount), 0);

      setEarnings({
        totalSubscriptionRevenue: totalSubscriptions,
        totalAdRevenue: totalAds,
        totalEarnings: totalSubscriptions + totalAds,
        monthlyBreakdown,
        paymentHistory: payments,
        adRevenueHistory: adRevenue,
        payoutHistory: payouts,
        pendingPayout,
      });
    } catch (err: any) {
      setError(err?.message || "Failed to load earnings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  return { earnings, loading, error, refetch: fetchEarnings };
}
