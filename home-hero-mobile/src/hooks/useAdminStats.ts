import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type AdminStats = {
  totalUsers: number;
  providers: number;
  consumers: number;
  jobsCompleted: number;
  revenue: number;
  flaggedJobs: number;
  pendingVerifications: number;
};

export function useAdminStats() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<AdminStats>("/admin/stats");
      setStats(res);
    } catch (err: any) {
      setError(err?.message || "Failed to fetch admin stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, error, refetch: fetchStats };
}
