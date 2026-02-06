import { useCallback, useState } from "react";
import { api } from "../lib/apiClient";

export type Category = {
  id: number;
  name: string;
  slug: string;
};

export type ProviderProfile = {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  location: string | null;
  experience: string | null;
  specialties: string | null;
  rating: number | null;
  reviewCount: number;
  verificationBadge?: boolean;
  verificationStatus?: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  isVerified?: boolean;
  isFavorited?: boolean;
  categories?: Category[];
};

export function useProviderProfile(providerId?: number) {
  const [profile, setProfile] = useState<ProviderProfile | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = providerId ? `/providers/${providerId}` : "/me";
      const user = await api.get<ProviderProfile>(endpoint);
      setProfile(user);
      if (user.categories) {
        setSelectedCategoryIds(user.categories.map((c) => c.id));
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  const fetchCategories = useCallback(async () => {
    try {
      const cats = await api.get<Category[]>("/categories");
      setCategories(cats);
    } catch (err: any) {
      console.error("Failed to fetch categories:", err);
    }
  }, []);

  const updateProfile = useCallback(
    async (data: {
      location?: string;
      experience?: string;
      specialties?: string;
    }) => {
      try {
        const updated = await api.put<ProviderProfile>(
          "/providers/me/profile",
          data
        );
        setProfile(updated);
        return updated;
      } catch (err: any) {
        throw new Error(err?.message ?? "Failed to update profile");
      }
    },
    []
  );

  const updateCategories = useCallback(
    async (categoryIds: number[]) => {
      try {
        await api.put("/providers/me/categories", { categoryIds });
        setSelectedCategoryIds(categoryIds);
      } catch (err: any) {
        throw new Error(err?.message ?? "Failed to update categories");
      }
    },
    []
  );

  return {
    profile,
    categories,
    selectedCategoryIds,
    loading,
    error,
    fetchProfile,
    fetchCategories,
    updateProfile,
    updateCategories,
  };
}
