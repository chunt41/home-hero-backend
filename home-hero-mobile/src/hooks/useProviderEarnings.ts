import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type EarningsItem = {
  jobId: number;
  jobTitle: string;
  bidAmount: number;
  status: "ACCEPTED" | string;
  completedAt?: string;
  consumerName?: string;
};

export type EarningsSummary = {
  totalEarnings: number;
  completedJobs: number;
  acceptedBids: number;
  averageEarningsPerJob: number;
  earnings: EarningsItem[];
};

export function useProviderEarnings() {
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEarnings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bidsRes = await api.get<any>(`/debug/provider-bids?providerId=2`);
      const bids: any[] = bidsRes.value ?? bidsRes ?? [];

      const completed = bids.filter(
        (bid: any) =>
          String(bid.status).toUpperCase() === "ACCEPTED" &&
          bid.job && String(bid.job.status).toUpperCase() === "COMPLETED"
      );
      const totalEarnings = completed.reduce(
        (sum: number, bid: any) => sum + (bid.amount || 0),
        0
      );

      const earnings: EarningsItem[] = completed.map((bid: any) => ({
        jobId: bid.job.id,
        jobTitle: bid.job.title,
        bidAmount: bid.amount,
        status: bid.status,
        completedAt: bid.job.createdAt,
        consumerName: bid.job.consumer?.name || "Unknown",
      }));

      const completedJobs = earnings.length;
      const averagePerJob = completedJobs > 0 ? totalEarnings / completedJobs : 0;

      setSummary({
        totalEarnings,
        completedJobs,
        acceptedBids: completed.length,
        averageEarningsPerJob: Math.round(averagePerJob * 100) / 100,
        earnings: earnings.sort(
          (a, b) =>
            new Date(b.completedAt || 0).getTime() -
            new Date(a.completedAt || 0).getTime()
        ),
      });
    } catch (err: any) {
      setError(err?.message || "Failed to fetch earnings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  return {
    summary,
    loading,
    error,
    refetch: fetchEarnings,
  };
}
