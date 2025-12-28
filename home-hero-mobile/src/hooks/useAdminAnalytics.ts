import { useState, useEffect } from "react";
import { api } from "../lib/apiClient";

export type AdminAnalytics = {
  range: string[];
  users: Record<string, number>;
  jobs: Record<string, number>;
  revenue: Record<string, number>;
};

export function useAdminAnalytics() {
  const [data, setData] = useState<AdminAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<AdminAnalytics>("/admin/analytics")
      .then(setData)
      .catch((err) => setError(err?.message || "Failed to fetch analytics"))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
