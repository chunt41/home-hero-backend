import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";
import { useAuth } from "../context/AuthContext";

type ProviderItem = {
  id: number;
  name: string | null;
  location: string | null;
  experience: string | null;
  specialties: string | null;
  rating: number | null;
  reviewCount: number;
  isFavorited: boolean;
  verificationStatus?: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  isVerified?: boolean;
  distanceMiles?: number | null;
  whyShown?: {
    distanceMiles: number | null;
    rating: number | null;
    ratingCount: number;
    responseTimeSeconds30d: number | null;
    isVerified: boolean;
    tierBoost: string | null;
  };
  scoreBreakdown?: {
    baseScore: number;
    distanceScore: number;
    ratingScore: number;
    responseScore: number;
    tierBoost: number;
    featuredBoost: number;
    verifiedBoost: number;
    finalScore: number;
  };
  stats?: {
    medianResponseTimeSeconds30d?: number | null;
  } | null;
  categories: { id: number; name: string; slug: string }[];
};

function formatMedianResponseTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "<1 min";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 24 * 60 * 60) return `${Math.round(seconds / 3600)} hr`;
  return `${Math.round(seconds / 86400)} day`;
}

function formatDistanceMiles(distanceMiles: number): string {
  if (!Number.isFinite(distanceMiles) || distanceMiles < 0) return "";
  if (distanceMiles < 0.1) return "<0.1 mi";
  if (distanceMiles < 10) return `${distanceMiles.toFixed(1)} mi`;
  return `${Math.round(distanceMiles)} mi`;
}

function whyMatchText(item: ProviderItem): string | null {
  const w = item.whyShown;

  const distanceMiles = w?.distanceMiles ?? item.distanceMiles ?? null;
  const rating = w?.rating ?? item.rating ?? null;
  const ratingCount = w?.ratingCount ?? item.reviewCount ?? 0;
  const responseSeconds =
    w?.responseTimeSeconds30d ?? item.stats?.medianResponseTimeSeconds30d ?? null;
  const isVerified = w?.isVerified ?? Boolean(item.isVerified);
  const tierBoost = w?.tierBoost ?? null;

  const parts: string[] = [];
  if (typeof distanceMiles === "number") {
    const formatted = formatDistanceMiles(distanceMiles);
    if (formatted) parts.push(formatted);
  }
  if (typeof rating === "number") {
    parts.push(`${rating.toFixed(1)}★ (${ratingCount})`);
  }
  if (typeof responseSeconds === "number") {
    const formatted = formatMedianResponseTime(responseSeconds);
    if (formatted) parts.push(`Responds ~${formatted}`);
  }
  if (isVerified) parts.push("Verified");
  if (tierBoost) parts.push(tierBoost);

  return parts.length ? parts.join(" • ") : null;
}

type ProvidersResponse = {
  items: ProviderItem[];
  pageInfo: {
    nextCursor: string | null;
  };
};

type Category = {
  id: string;
  name: string;
  slug: string;
};

type SortMode = "relevance" | "distance" | "rating" | "responseTime";

type PersistedDiscoveryFiltersV1 = {
  v: 1;
  zip: string;
  radiusMiles: number;
  verifiedOnly: boolean;
  selectedCategorySlugs: string[];
  minRating: number | null;
  sort: SortMode;
};

const DEFAULT_FILTERS: Omit<PersistedDiscoveryFiltersV1, "v"> = {
  zip: "",
  radiusMiles: 25,
  verifiedOnly: false,
  selectedCategorySlugs: [],
  minRating: null,
  sort: "relevance",
};

const ANON_DISCOVERY_FILTERS_KEY = "homeHero.providerDiscovery.filters.v1.anon";

function safeParsePersistedFilters(raw: string | null): PersistedDiscoveryFiltersV1 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedDiscoveryFiltersV1;
    if (!parsed || parsed.v !== 1) return null;
    if (typeof parsed.zip !== "string") return null;
    if (!Number.isFinite(parsed.radiusMiles)) return null;
    if (!Array.isArray(parsed.selectedCategorySlugs)) return null;
    if (parsed.minRating !== null && !Number.isFinite(parsed.minRating)) return null;
    if (!["relevance", "distance", "rating", "responseTime"].includes(parsed.sort)) return null;

    return {
      v: 1,
      zip: parsed.zip,
      radiusMiles: Math.max(1, Math.min(100, Math.round(parsed.radiusMiles))),
      verifiedOnly: !!(parsed as any).verifiedOnly,
      selectedCategorySlugs: parsed.selectedCategorySlugs.filter((s) => typeof s === "string" && s.trim()),
      minRating: parsed.minRating === null ? null : Math.max(0, Math.min(5, Number(parsed.minRating))),
      sort: parsed.sort,
    };
  } catch {
    return null;
  }
}

function sortLabel(sort: SortMode): string {
  if (sort === "relevance") return "Relevance";
  if (sort === "distance") return "Distance";
  if (sort === "rating") return "Rating";
  return "Response time";
}

function minRatingLabel(minRating: number | null): string {
  if (minRating === null) return "Any";
  if (minRating >= 4.5) return "4.5+";
  if (minRating >= 4) return "4.0+";
  if (minRating >= 3) return "3.0+";
  return `${minRating.toFixed(1)}+`;
}

export default function ProviderDiscoveryScreen() {
  const { user, isBooting } = useAuth();

  const [filtersHydrated, setFiltersHydrated] = useState(false);
  const [persistEnabled, setPersistEnabled] = useState(false);
  const [activeStorageKey, setActiveStorageKey] = useState(ANON_DISCOVERY_FILTERS_KEY);
  const [hydratedUserId, setHydratedUserId] = useState<number | null>(null);

  const [zip, setZip] = useState("");
  const [radiusMiles, setRadiusMiles] = useState(DEFAULT_FILTERS.radiusMiles);
  const [verifiedOnly, setVerifiedOnly] = useState(DEFAULT_FILTERS.verifiedOnly);
  const [selectedCategorySlugs, setSelectedCategorySlugs] = useState<string[]>(DEFAULT_FILTERS.selectedCategorySlugs);
  const [minRating, setMinRating] = useState<number | null>(DEFAULT_FILTERS.minRating);
  const [sort, setSort] = useState<SortMode>(DEFAULT_FILTERS.sort);

  // Draft values inside the modal (applied on "Apply")
  const [draftRadiusMiles, setDraftRadiusMiles] = useState(DEFAULT_FILTERS.radiusMiles);
  const [draftVerifiedOnly, setDraftVerifiedOnly] = useState(DEFAULT_FILTERS.verifiedOnly);
  const [draftSelectedCategorySlugs, setDraftSelectedCategorySlugs] = useState<string[]>(DEFAULT_FILTERS.selectedCategorySlugs);
  const [draftMinRating, setDraftMinRating] = useState<number | null>(DEFAULT_FILTERS.minRating);
  const [draftSort, setDraftSort] = useState<SortMode>(DEFAULT_FILTERS.sort);

  const [categories, setCategories] = useState<Category[]>([]);
  const [showFiltersModal, setShowFiltersModal] = useState(false);

  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await api.get<Category[]>("/categories");
      setCategories(res || []);
    } catch (err) {
      console.error("Failed to fetch categories:", err);
    }
  }, []);

  // Fetch categories on mount
  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const userStorageKey = useMemo(() => {
    return user?.id ? `homeHero.providerDiscovery.filters.v1.${String(user.id)}` : null;
  }, [user?.id]);

  const applyMergedFilters = useCallback((merged: typeof DEFAULT_FILTERS) => {
    setZip(merged.zip);
    setRadiusMiles(merged.radiusMiles);
    setVerifiedOnly(merged.verifiedOnly);
    setSelectedCategorySlugs(merged.selectedCategorySlugs);
    setMinRating(merged.minRating);
    setSort(merged.sort);

    // Keep drafts in sync so opening the modal reflects applied filters.
    setDraftRadiusMiles(merged.radiusMiles);
    setDraftVerifiedOnly(merged.verifiedOnly);
    setDraftSelectedCategorySlugs(merged.selectedCategorySlugs);
    setDraftMinRating(merged.minRating);
    setDraftSort(merged.sort);
  }, []);

  const hydrateFromStorageKey = useCallback(async (key: string, opts?: { applyIfMissing?: boolean }) => {
    const raw = await AsyncStorage.getItem(key);
    const persisted = safeParsePersistedFilters(raw);

    if (!persisted && opts?.applyIfMissing === false) {
      return { found: false };
    }

    const merged = {
      ...DEFAULT_FILTERS,
      ...(persisted
        ? {
            zip: persisted.zip,
            radiusMiles: persisted.radiusMiles,
            verifiedOnly: persisted.verifiedOnly,
            selectedCategorySlugs: persisted.selectedCategorySlugs,
            minRating: persisted.minRating,
            sort: persisted.sort,
          }
        : null),
    };

    applyMergedFilters(merged);
    return { found: !!persisted };
  }, [applyMergedFilters]);

  // 1) Hydrate anonymous filters ASAP on app launch (before auth finishes).
  useEffect(() => {
    let mounted = true;

    (async () => {
      setPersistEnabled(false);
      try {
        setActiveStorageKey(ANON_DISCOVERY_FILTERS_KEY);
        await hydrateFromStorageKey(ANON_DISCOVERY_FILTERS_KEY, { applyIfMissing: true });
      } finally {
        if (!mounted) return;
        setFiltersHydrated(true);
        setPersistEnabled(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [hydrateFromStorageKey]);

  // 2) Once auth is ready, hydrate user-specific filters and switch persistence to that key.
  useEffect(() => {
    if (isBooting) return;
    if (!user?.id) {
      // Logged out state: ensure persistence goes back to anon.
      setHydratedUserId(null);
      setActiveStorageKey(ANON_DISCOVERY_FILTERS_KEY);
      return;
    }

    if (hydratedUserId === user.id) return;

    let mounted = true;
    (async () => {
      setPersistEnabled(false);
      try {
        const key = userStorageKey;
        if (!key) return;
        setActiveStorageKey(key);
        // Only apply user filters if they exist; otherwise keep current (likely anon) filters.
        await hydrateFromStorageKey(key, { applyIfMissing: false });
        if (!mounted) return;
        setHydratedUserId(user.id);
      } finally {
        if (!mounted) return;
        setPersistEnabled(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [isBooting, user?.id, userStorageKey, hydratedUserId, hydrateFromStorageKey]);

  // If the user logs out, restore the anon filters (best-effort).
  useEffect(() => {
    if (isBooting) return;
    if (user?.id) return;

    let mounted = true;
    (async () => {
      setPersistEnabled(false);
      try {
        setActiveStorageKey(ANON_DISCOVERY_FILTERS_KEY);
        await hydrateFromStorageKey(ANON_DISCOVERY_FILTERS_KEY, { applyIfMissing: true });
      } finally {
        if (!mounted) return;
        setPersistEnabled(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [isBooting, user?.id, hydrateFromStorageKey]);

  // Persist applied filters (per-user).
  useEffect(() => {
    if (!filtersHydrated) return;
    if (!persistEnabled) return;

    const payload: PersistedDiscoveryFiltersV1 = {
      v: 1,
      zip,
      radiusMiles,
      verifiedOnly,
      selectedCategorySlugs,
      minRating,
      sort,
    };

    const t = setTimeout(() => {
      AsyncStorage.setItem(activeStorageKey, JSON.stringify(payload)).catch(() => {
        // ignore
      });
    }, 250);

    return () => clearTimeout(t);
  }, [filtersHydrated, persistEnabled, zip, radiusMiles, verifiedOnly, selectedCategorySlugs, minRating, sort, activeStorageKey]);

  const fetchProviders = useCallback(
    async (mode: "initial" | "refresh" | "more") => {
      const isInitial = mode === "initial";
      const isRefresh = mode === "refresh";
      const isMore = mode === "more";

      if (isInitial) {
        setLoadingInitial(true);
        setError(null);
      } else if (isRefresh) {
        setRefreshing(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const zip5 = (zip.match(/\d{5}/)?.[0] ?? "").trim();
        if (!zip5) {
          setProviders([]);
          setNextCursor(null);
          setError("Enter a 5-digit ZIP code to search.");
          return;
        }

        const query = new URLSearchParams();
        query.set("zip", zip5);
        query.set("radiusMiles", String(radiusMiles));
        if (verifiedOnly) query.set("verifiedOnly", "true");
        if (selectedCategorySlugs.length > 0) {
          query.set("categories", selectedCategorySlugs.join(","));
        }
        if (minRating !== null) query.set("minRating", String(minRating));
        query.set("sort", sort);
        query.set("limit", "15");
        if (isMore && nextCursor) query.set("cursor", nextCursor);

        const url = `/providers/search?${query.toString()}`;
        const res = (await api.get(url)) as ProvidersResponse;

        if (!res || !Array.isArray(res.items) || !res.pageInfo) {
          setError("No response from server");
          setProviders([]);
          return;
        }

        if (isMore) {
          setProviders((prev) => [...prev, ...res.items]);
        } else {
          setProviders(res.items);
        }

        setNextCursor(res.pageInfo.nextCursor ?? null);
        setError(null);
      } catch (err) {
        console.error(`Error fetching providers (${mode}):`, err);
        setError("Failed to load providers. Please try again.");
      } finally {
        if (isInitial) setLoadingInitial(false);
        else if (isRefresh) setRefreshing(false);
        else setLoadingMore(false);
      }
    },
    [zip, radiusMiles, verifiedOnly, selectedCategorySlugs, minRating, sort, nextCursor]
  );

  const toggleFavorite = useCallback(async (providerId: number) => {
    try {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;

      if (provider.isFavorited) {
        await api.delete(`/providers/${providerId}/favorite`);
      } else {
        await api.post(`/providers/${providerId}/favorite`, {});
      }

      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId
            ? { ...p, isFavorited: !p.isFavorited }
            : p
        )
      );
    } catch (err) {
      console.error("Error toggling favorite:", err);
    }
  }, [providers]);

  // Debounced search (after filters hydrate so we don't immediately overwrite restored state)
  useEffect(() => {
    if (!filtersHydrated) return;
    const t = setTimeout(() => {
      setNextCursor(null);
      fetchProviders("initial");
    }, 400);
    return () => clearTimeout(t);
  }, [filtersHydrated, zip, radiusMiles, verifiedOnly, selectedCategorySlugs, minRating, sort, fetchProviders]);

  const onRefresh = useCallback(() => {
    setNextCursor(null);
    fetchProviders("refresh");
  }, [fetchProviders]);

  const onEndReached = useCallback(() => {
    if (nextCursor && !loadingMore && !loadingInitial) {
      fetchProviders("more");
    }
  }, [nextCursor, loadingMore, loadingInitial, fetchProviders]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (radiusMiles !== 25) count++;
    if (verifiedOnly) count++;
    if (selectedCategorySlugs.length) count++;
    if (minRating !== null) count++;
    if (sort !== "relevance") count++;
    return count;
  }, [radiusMiles, verifiedOnly, selectedCategorySlugs, minRating, sort]);

  const openFilters = useCallback(() => {
    // Snapshot applied values into draft
    setDraftRadiusMiles(radiusMiles);
    setDraftVerifiedOnly(verifiedOnly);
    setDraftSelectedCategorySlugs(selectedCategorySlugs);
    setDraftMinRating(minRating);
    setDraftSort(sort);
    setShowFiltersModal(true);
  }, [radiusMiles, verifiedOnly, selectedCategorySlugs, minRating, sort]);

  const resetAppliedFilters = useCallback((opts?: { keepZip?: boolean }) => {
    setShowFiltersModal(false);

    if (!opts?.keepZip) setZip(DEFAULT_FILTERS.zip);
    setRadiusMiles(DEFAULT_FILTERS.radiusMiles);
    setVerifiedOnly(DEFAULT_FILTERS.verifiedOnly);
    setSelectedCategorySlugs(DEFAULT_FILTERS.selectedCategorySlugs);
    setMinRating(DEFAULT_FILTERS.minRating);
    setSort(DEFAULT_FILTERS.sort);

    // Keep drafts in sync.
    setDraftRadiusMiles(DEFAULT_FILTERS.radiusMiles);
    setDraftVerifiedOnly(DEFAULT_FILTERS.verifiedOnly);
    setDraftSelectedCategorySlugs(DEFAULT_FILTERS.selectedCategorySlugs);
    setDraftMinRating(DEFAULT_FILTERS.minRating);
    setDraftSort(DEFAULT_FILTERS.sort);

    setNextCursor(null);
    // Fetch is triggered by the debounced useEffect.
  }, []);

  const renderProviderCard = ({ item }: { item: ProviderItem }) => (
    <Pressable
      style={styles.card}
      onPress={() => router.push({ pathname: "/provider/[id]", params: { id: String(item.id) } })}
    >
      <View style={styles.cardHeader}>
        <View style={styles.providerInfo}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(item.name || "P")[0].toUpperCase()}
            </Text>
          </View>
          <View style={styles.details}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name ?? "Provider"}
              </Text>
              {item.isVerified ? (
                <View style={styles.verifiedBadge}>
                  <MaterialCommunityIcons
                    name="check-decagram"
                    size={14}
                    color="#34d399"
                  />
                  <Text style={styles.verifiedText}>Verified</Text>
                </View>
              ) : null}
            </View>
            {item.location && (
              <Text style={styles.location} numberOfLines={1}>
                📍 {item.location}
              </Text>
            )}
            {item.rating !== null && (
              <View style={styles.ratingRow}>
                <MaterialCommunityIcons name="star" size={12} color="#f59e0b" />
                <Text style={styles.rating}>
                  {item.rating.toFixed(1)} ({item.reviewCount})
                </Text>
              </View>
            )}

            {typeof item.stats?.medianResponseTimeSeconds30d === "number" && (
              <Text style={styles.responseTime} numberOfLines={1}>
                Typically responds in {formatMedianResponseTime(item.stats.medianResponseTimeSeconds30d)}
              </Text>
            )}
          </View>
        </View>

        <Pressable
          onPress={(e) => {
            e.stopPropagation?.();
            toggleFavorite(item.id);
          }}
          hitSlop={10}
        >
          <MaterialCommunityIcons
            name={item.isFavorited ? "heart" : "heart-outline"}
            size={20}
            color={item.isFavorited ? "#ef4444" : "#94a3b8"}
          />
        </Pressable>
      </View>

      {whyMatchText(item) ? (
        <View style={styles.whyRow}>
          <Text style={styles.whyLabel}>Why this match?</Text>
          <Text style={styles.whyText} numberOfLines={2}>
            {whyMatchText(item)}
          </Text>
        </View>
      ) : null}

      {item.specialties && (
        <Text style={styles.specialties} numberOfLines={2}>
          {item.specialties}
        </Text>
      )}

      {item.categories.length > 0 && (
        <View style={styles.categoriesRow}>
          {item.categories.slice(0, 3).map((cat) => (
            <View key={cat.id} style={styles.categoryTag}>
              <Text style={styles.categoryTagText}>{cat.name}</Text>
            </View>
          ))}
          {item.categories.length > 3 && (
            <Text style={styles.moreCategories}>
              +{item.categories.length - 3} more
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Find Providers</Text>
        <Pressable
          style={styles.filterButton}
          onPress={openFilters}
        >
          <MaterialCommunityIcons name="tune" size={24} color="#38bdf8" />
          {activeFilterCount > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          value={zip}
          onChangeText={setZip}
          placeholder="ZIP code…"
          placeholderTextColor="#94a3b8"
          style={styles.input}
          keyboardType="number-pad"
          maxLength={10}
        />

        <View style={styles.metaRow}>
          <Text style={styles.metaText}>Sort: {sortLabel(sort)}</Text>
          {minRating !== null ? <Text style={styles.metaText}>Min rating: {minRatingLabel(minRating)}</Text> : null}
        </View>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => fetchProviders("initial")}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loadingInitial ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading providers…</Text>
        </View>
      ) : (
        <FlatList
          data={providers}
          keyExtractor={(x) => String(x.id)}
          renderItem={renderProviderCard}
          contentContainerStyle={
            providers.length === 0 ? styles.emptyContainer : styles.listContainer
          }
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No providers found.</Text>
              <Text style={styles.emptySubText}>
                Try adjusting your search criteria.
              </Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator />
                <Text style={styles.loadingText}>Loading more…</Text>
              </View>
            ) : null
          }
        />
      )}

      {/* Filter Modal */}
      <Modal
        visible={showFiltersModal}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowFiltersModal(false)}
      >
        <SafeAreaView style={styles.modalContainer} edges={["top"]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter Providers</Text>
            <Pressable onPress={() => setShowFiltersModal(false)}>
              <MaterialCommunityIcons name="close" size={28} color="#fff" />
            </Pressable>
          </View>

          <ScrollView style={styles.modalContent}>
            {/* Sort */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Sort By</Text>
              <View style={styles.ratingSelector}>
                {([
                  { key: "relevance", label: "Relevance" },
                  { key: "distance", label: "Distance" },
                  { key: "rating", label: "Rating" },
                  { key: "responseTime", label: "Response" },
                ] as { key: SortMode; label: string }[]).map((opt) => (
                  <Pressable
                    key={opt.key}
                    style={[styles.ratingButton, draftSort === opt.key && styles.ratingButtonActive]}
                    onPress={() => setDraftSort(opt.key)}
                  >
                    <Text style={[styles.ratingButtonText, draftSort === opt.key && styles.ratingButtonTextActive]}>
                      {opt.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Radius */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Search Radius</Text>
              <View style={styles.sliderHeaderRow}>
                <Text style={styles.sliderLabel}>1 mi</Text>
                <Text style={styles.sliderValue}>{draftRadiusMiles} mi</Text>
                <Text style={styles.sliderLabel}>100 mi</Text>
              </View>
              <Slider
                value={draftRadiusMiles}
                minimumValue={1}
                maximumValue={100}
                step={1}
                onValueChange={(v) => setDraftRadiusMiles(Math.round(v))}
                minimumTrackTintColor="#38bdf8"
                maximumTrackTintColor="#1e293b"
                thumbTintColor="#38bdf8"
              />
            </View>

            {/* Min rating */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Minimum Rating</Text>
              <View style={styles.ratingSelector}>
                {([
                  { key: null, label: "Any" },
                  { key: 3, label: "3.0+" },
                  { key: 4, label: "4.0+" },
                  { key: 4.5, label: "4.5+" },
                ] as { key: number | null; label: string }[]).map((opt) => {
                  const isActive = draftMinRating === opt.key;
                  return (
                    <Pressable
                      key={String(opt.key)}
                      style={[styles.ratingButton, isActive && styles.ratingButtonActive]}
                      onPress={() => setDraftMinRating(opt.key)}
                    >
                      <Text style={[styles.ratingButtonText, isActive && styles.ratingButtonTextActive]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Verified */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Verified Only</Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ color: "#cbd5e1" }}>Show only verified providers</Text>
                <Switch value={draftVerifiedOnly} onValueChange={setDraftVerifiedOnly} />
              </View>
            </View>

            {/* Categories */}
            {categories.length > 0 && (
              <View style={styles.filterSection}>
                <Text style={styles.filterSectionTitle}>Categories</Text>
                <View style={styles.categoryGrid}>
                  {categories.map((cat) => {
                    const isSelected = draftSelectedCategorySlugs.includes(cat.slug);
                    return (
                      <Pressable
                        key={cat.id}
                        style={[
                          styles.categoryButton,
                          isSelected && styles.categoryButtonActive,
                        ]}
                        onPress={() => {
                          setDraftSelectedCategorySlugs((prev) =>
                            isSelected
                              ? prev.filter((c) => c !== cat.slug)
                              : [...prev, cat.slug]
                          );
                        }}
                      >
                        <Text
                          style={[
                            styles.categoryButtonText,
                            isSelected && styles.categoryButtonTextActive,
                          ]}
                        >
                          {cat.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Clear Filters */}
            {activeFilterCount > 0 && (
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  resetAppliedFilters({ keepZip: true });
                }}
              >
                <Text style={styles.clearBtnText}>Reset filters</Text>
              </Pressable>
            )}
          </ScrollView>

          <Pressable
            style={styles.applyBtn}
            onPress={() => {
              setShowFiltersModal(false);

              setRadiusMiles(draftRadiusMiles);
              setVerifiedOnly(draftVerifiedOnly);
              setSelectedCategorySlugs(draftSelectedCategorySlugs);
              setMinRating(draftMinRating);
              setSort(draftSort);

              setNextCursor(null);
              // Fetch is triggered by the debounced useEffect.
            }}
          >
            <Text style={styles.applyBtnText}>Apply Filters</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 10,
    paddingTop: 8,
  },
  screenTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "800",
  },
  filterButton: {
    position: "relative",
    padding: 8,
  },
  filterBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: "#ef4444",
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  filterBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
  },

  searchRow: { paddingHorizontal: 16, gap: 10, marginBottom: 10 },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  metaText: {
    color: "#94a3b8",
    fontSize: 12,
  },
  input: {
    backgroundColor: "#0f172a",
    color: "#ffffff",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    fontSize: 14,
  },

  listContainer: { paddingHorizontal: 16, paddingBottom: 20 },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },

  card: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
    gap: 12,
  },

  providerInfo: {
    flexDirection: "row",
    flex: 1,
    gap: 12,
  },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
  },

  avatarText: {
    color: "#38bdf8",
    fontSize: 18,
    fontWeight: "800",
  },

  details: {
    flex: 1,
  },

  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  name: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },

  verifiedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.35)",
  },

  verifiedText: {
    color: "#a7f3d0",
    fontSize: 12,
    fontWeight: "700",
  },

  location: {
    color: "#cbd5e1",
    fontSize: 12,
    marginTop: 2,
  },

  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },

  rating: {
    color: "#f59e0b",
    fontSize: 12,
    fontWeight: "600",
  },

  specialties: {
    color: "#cbd5e1",
    fontSize: 12,
    marginBottom: 10,
  },

  responseTime: {
    color: "#94a3b8",
    fontSize: 12,
    marginTop: 2,
  },

  whyRow: {
    marginTop: 6,
    marginBottom: 10,
  },
  whyLabel: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 2,
  },
  whyText: {
    color: "#cbd5e1",
    fontSize: 12,
  },

  categoriesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },

  categoryTag: {
    backgroundColor: "#1e293b",
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },

  categoryTagText: {
    color: "#38bdf8",
    fontSize: 11,
    fontWeight: "600",
  },

  moreCategories: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
  },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  loadingText: { color: "#cbd5e1", marginTop: 10 },
  emptyText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  emptySubText: { color: "#94a3b8", marginTop: 6, textAlign: "center" },

  footerLoader: { paddingVertical: 16, alignItems: "center" },

  errorBox: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  errorText: { color: "#fca5a5", marginBottom: 10 },
  retryBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#38bdf8",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "800" },

  // Modal styles
  modalContainer: { flex: 1, backgroundColor: "#020617" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "800" },
  modalContent: { flex: 1, padding: 16 },

  filterSection: { marginBottom: 24 },
  sliderHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sliderLabel: { color: "#94a3b8", fontSize: 12 },
  sliderValue: { color: "#fff", fontSize: 14, fontWeight: "800" },
  filterSectionTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },

  ratingSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },

  ratingButton: {
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },

  ratingButtonActive: {
    backgroundColor: "#f59e0b",
    borderColor: "#f59e0b",
  },

  ratingButtonText: { color: "#cbd5e1", fontWeight: "600", fontSize: 13 },
  ratingButtonTextActive: { color: "#020617", fontWeight: "700" },

  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  categoryButton: {
    flex: 0.45,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#38bdf8",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  categoryButtonActive: {
    backgroundColor: "#38bdf8",
    borderColor: "#38bdf8",
  },
  categoryButtonText: { color: "#cbd5e1", fontWeight: "600", fontSize: 13 },
  categoryButtonTextActive: { color: "#020617", fontWeight: "700" },

  clearBtn: {
    backgroundColor: "#374151",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    marginVertical: 16,
  },
  clearBtnText: { color: "#e2e8f0", fontWeight: "700" },

  applyBtn: {
    backgroundColor: "#38bdf8",
    marginHorizontal: 16,
    marginVertical: 16,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  applyBtnText: { color: "#020617", fontWeight: "800", fontSize: 16 },
});
