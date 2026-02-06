import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type BidForConsumer = {
  id: number;
  amount: number;
  message: string | null;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
  createdAt: string;
  provider: {
    id: number;
    name: string;
    location: string | null;
    rating: number | null;
    reviewCount: number;
  };
  counter: {
    id: number;
    minAmount: number;
    maxAmount: number;
    amount: number;
    message: string | null;
    status: "PENDING" | "ACCEPTED" | "DECLINED";
    createdAt: string;
  } | null;
};

export function useConsumerJobBids(jobId: number) {
  const [bids, setBids] = useState<BidForConsumer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBids = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await api.get<BidForConsumer[]>(`/jobs/${jobId}/bids`);
      setBids(res || []);
    } catch (err: any) {
      setError(err?.message || "Failed to load bids");
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  const acceptBid = useCallback(
    async (bidId: number) => {
      try {
        // Prefer the unified award endpoint (falls back to legacy accept endpoint if needed).
        try {
          await api.post(`/jobs/${jobId}/award`, { bidId });
        } catch (_e) {
          await api.post(`/jobs/${jobId}/bids/${bidId}/accept`, {});
        }
        // Update local state
        setBids((prev) =>
          prev.map((b) =>
            b.id === bidId ? { ...b, status: "ACCEPTED" } : b
          )
        );
      } catch (err: any) {
        throw err?.message || "Failed to accept bid";
      }
    },
    [jobId]
  );

  const rejectBid = useCallback(
    async (bidId: number) => {
      try {
        await api.post(`/jobs/${jobId}/bids/${bidId}/reject`, {});
        // Update local state
        setBids((prev) =>
          prev.map((b) =>
            b.id === bidId ? { ...b, status: "DECLINED" } : b
          )
        );
      } catch (err: any) {
        throw err?.message || "Failed to reject bid";
      }
    },
    [jobId]
  );

  useEffect(() => {
    fetchBids();
  }, [fetchBids]);

  const stats = {
    total: bids.length,
    pending: bids.filter((b) => b.status === "PENDING").length,
    accepted: bids.filter((b) => b.status === "ACCEPTED").length,
    declined: bids.filter((b) => b.status === "DECLINED").length,
  };

  return {
    bids,
    loading,
    error,
    stats,
    fetchBids,
    acceptBid,
    rejectBid,
  };
}
