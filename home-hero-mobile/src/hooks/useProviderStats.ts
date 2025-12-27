import { useCallback, useState } from "react";
import { api } from "../lib/apiClient";

export type ProviderBid = {
  id: number;
  amount: number;
  message: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | string;
  createdAt: string;
  job: {
    id: number;
    title: string;
    location: string | null;
    status: string;
    createdAt: string;
  };
};

export type ProviderStats = {
  totalBids: number;
  activeBids: number;
  acceptedBids: number;
  recentBids: ProviderBid[];
};

const calculateStats = (bids: ProviderBid[]): ProviderStats => {
  const totalBids = bids.length;
  const activeBids = bids.filter((b) => b.status === "PENDING").length;
  const acceptedBids = bids.filter((b) => b.status === "ACCEPTED").length;
  const recentBids = bids.slice(0, 5);

  return {
    totalBids,
    activeBids,
    acceptedBids,
    recentBids,
  };
};

export function useProviderStats() {
  const [stats, setStats] = useState<ProviderStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bids = await api.get<ProviderBid[]>("/provider/bids");
      const calculated = calculateStats(bids);
      setStats(calculated);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load provider stats");
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { stats, loading, error, fetch };
}
