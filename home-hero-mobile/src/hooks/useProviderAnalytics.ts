import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type AnalyticsData = {
  totalEarnings: number;
  acceptedBids: number;
  completedJobs: number;
  pendingBids: number;
  declinedBids: number;
  bidAcceptanceRate: number; // percentage
  averageEarningsPerJob: number;

  // Earnings by month (last 6 months)
  earningsByMonth: Array<{
    month: string; // "Jan", "Feb", etc.
    earnings: number;
  }>;

  // Jobs by category
  jobsByCategory: Array<{
    name: string;
    count: number;
  }>;

  // Bid status breakdown
  bidStats: {
    total: number;
    accepted: number;
    pending: number;
    declined: number;
  };

  // Recent jobs (last 10)
  recentJobs: Array<{
    id: number;
    title: string;
    bidAmount: number;
    status: string;
    completedAt?: string;
    categoryName?: string;
  }>;
};

export function useProviderAnalytics() {
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch all provider bids
      const bidsRes = await api.get<any>("/provider/bids?limit=200");
      const bids: any[] = Array.isArray(bidsRes) ? bidsRes : bidsRes?.items || [];

      // Calculate bid statistics
      const acceptedCount = bids.filter((b: any) => b.status === "ACCEPTED").length;
      const pendingCount = bids.filter((b: any) => b.status === "PENDING").length;
      const declinedCount = bids.filter((b: any) => b.status === "DECLINED").length;
      const totalBids = bids.length;
      const acceptanceRate =
        totalBids > 0 ? Math.round((acceptedCount / totalBids) * 100) : 0;

      // Fetch job details for earnings and category data
      let totalEarnings = 0;
      let completedCount = 0;
      const earningsMap: { [key: string]: number } = {};
      const categoryMap: { [key: string]: number } = {};
      const recentJobsList: AnalyticsData["recentJobs"] = [];

      for (const bid of bids.slice(0, 100)) {
        try {
          const jobRes = await api.get<any>(`/provider/jobs/${bid.jobId}`);
          const job = jobRes?.job ?? jobRes;

          if (job) {
            const bidAmount = bid.counterOffer?.amount || bid.amount || 0;

            // Track earnings
            if (String(bid.status || "").toUpperCase() === "ACCEPTED") {
              totalEarnings += bidAmount;

              // Calculate month key for earnings by month
              if (job.updatedAt || job.createdAt) {
                const date = new Date(job.updatedAt || job.createdAt);
                const monthKey = date.toLocaleString("default", {
                  month: "short",
                  year: "2-digit",
                });
                earningsMap[monthKey] =
                  (earningsMap[monthKey] || 0) + bidAmount;
              }
            }

            // Count completed jobs
            if (String(job.status || "").toUpperCase() === "COMPLETED") {
              completedCount++;
            }

            // Track categories
            if (job.categoryName) {
              categoryMap[job.categoryName] =
                (categoryMap[job.categoryName] || 0) + 1;
            } else if (job.category?.name) {
              categoryMap[job.category.name] =
                (categoryMap[job.category.name] || 0) + 1;
            }

            // Add to recent jobs
            if (recentJobsList.length < 10) {
              recentJobsList.push({
                id: job.id,
                title: job.title,
                bidAmount,
                status: job.status,
                completedAt:
                  String(job.status || "").toUpperCase() === "COMPLETED"
                    ? job.updatedAt || job.createdAt
                    : undefined,
                categoryName: job.categoryName || job.category?.name,
              });
            }
          }
        } catch (err) {
          // Skip if individual job fetch fails
          console.error(`Failed to fetch job ${bid.jobId}:`, err);
        }
      }

      // Build earnings by month (last 6 months)
      const earningsByMonth: AnalyticsData["earningsByMonth"] = [];
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthKey = date.toLocaleString("default", {
          month: "short",
          year: "2-digit",
        });
        earningsByMonth.push({
          month: monthKey,
          earnings: earningsMap[monthKey] || 0,
        });
      }

      // Build jobs by category
      const jobsByCategory = Object.entries(categoryMap).map(
        ([name, count]) => ({
          name,
          count,
        })
      );

      const averageEarnings =
        completedCount > 0 ? totalEarnings / completedCount : 0;

      setAnalytics({
        totalEarnings,
        acceptedBids: acceptedCount,
        completedJobs: completedCount,
        pendingBids: pendingCount,
        declinedBids: declinedCount,
        bidAcceptanceRate: acceptanceRate,
        averageEarningsPerJob: averageEarnings,
        earningsByMonth,
        jobsByCategory,
        bidStats: {
          total: totalBids,
          accepted: acceptedCount,
          pending: pendingCount,
          declined: declinedCount,
        },
        recentJobs: recentJobsList,
      });
    } catch (err: any) {
      console.error("Failed to fetch analytics:", err);
      setError(err?.message ?? "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  return {
    analytics,
    loading,
    error,
    refetch: fetchAnalytics,
  };
}
