import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/apiClient";

export type Review = {
  id: number;
  rating: number;
  text: string | null;
  createdAt: string;
  job: {
    id: number;
    title: string;
  };
  reviewer: {
    id: number;
    name: string;
  } | null;
};

export type ReviewsSummary = {
  provider: {
    id: number;
    name: string;
    email: string;
  };
  ratingSummary: {
    averageRating: number | null;
    reviewCount: number;
  };
  reviews: Review[];
};

export function useProviderReviews(providerId: number, options?: { limit?: number }) {
  const [summary, setSummary] = useState<ReviewsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const limit = options?.limit;
      const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      const data = await api.get<ReviewsSummary>(`/providers/${providerId}/reviews${qs}`);
      setSummary(data);
    } catch (err: any) {
      setError(err?.message || "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }, [providerId, options?.limit]);

  useEffect(() => {
    if (providerId) {
      fetchReviews();
    }
  }, [providerId, fetchReviews]);

  const ratingDistribution = summary
    ? {
        fiveStar: summary.reviews.filter((r) => r.rating === 5).length,
        fourStar: summary.reviews.filter((r) => r.rating === 4).length,
        threeStar: summary.reviews.filter((r) => r.rating === 3).length,
        twoStar: summary.reviews.filter((r) => r.rating === 2).length,
        oneStar: summary.reviews.filter((r) => r.rating === 1).length,
      }
    : null;

  return {
    summary,
    loading,
    error,
    refetch: fetchReviews,
    ratingDistribution,
  };
}
