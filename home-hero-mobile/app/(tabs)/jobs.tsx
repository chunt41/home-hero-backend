import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "../../src/lib/apiClient";
import { router, Redirect } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAdConfig } from "../../src/hooks/useAdConfig";
import { useInterstitialAd } from "../../src/hooks/useInterstitialAd";
import { BannerAdComponent } from "../../src/components/BannerAdComponent";

type JobBrowseItem = {
  id: number;
  title: string;
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  status: "OPEN" | string;
  location: string | null;
  category?: string | null;
  urgency?: string | null;
  createdAt: string;
  bidCount: number;
  isFavorited: boolean;
  consumer: { id: number; name: string | null; location: string | null };
  attachments: any[];
};

type JobsBrowseResponse = {
  items: JobBrowseItem[];
  pageInfo: { limit: number; nextCursor: number | null };
};

type Category = {
  id: string;
  name: string;
  slug: string;
};

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    qs.set(k, s);
  }
  const out = qs.toString();
  return out ? `?${out}` : "";
}

function urgencyLabel(u?: string | null) {
  const v = (u ?? "").toUpperCase().trim();
  if (v === "URGENT") return "Urgent";
  if (v === "SOON") return "Soon";
  if (v === "NORMAL") return "Normal";
  return u ?? null;
}

function urgencyPillStyle(u?: string | null) {
  const v = (u ?? "").toUpperCase().trim();
  if (v === "URGENT") return styles.pillUrgent;
  if (v === "SOON") return styles.pillSoon;
  if (v === "NORMAL") return styles.pillNormal;
  return styles.pillNormal;
}

export default function JobsScreen() {
  const { user } = useAuth();
  const { showBannerAds, showInterstitialAds, inlineBannerEvery, showFooterBanner } =
    useAdConfig();
  const { showAd } = useInterstitialAd(showInterstitialAds);

  const isProvider = user?.role === "PROVIDER";

  const [q, setQ] = useState("");
  const [location, setLocation] = useState("");
  const [minBudget, setMinBudget] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [showFiltersModal, setShowFiltersModal] = useState(false);

  const [items, setItems] = useState<JobBrowseItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  // ✅ Cursor ref prevents "load more" from triggering a re-fetch that resets scroll
  const nextCursorRef = useRef<number | null>(null);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

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

  const toggleFavorite = useCallback(async (jobId: number) => {
    // optimistic update
    setItems((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, isFavorited: !j.isFavorited } : j))
    );

    // read the new value (after optimistic flip)
    const nowFav =
        items.find((j) => j.id === jobId)?.isFavorited === false; // was false -> now true

    try {
        if (nowFav) {
        await api.post(`/jobs/${jobId}/favorite`);
        } else {
        await api.delete(`/jobs/${jobId}/favorite`);
        }
    } catch {
        // revert if request fails
        setItems((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, isFavorited: !j.isFavorited } : j))
        );
    }
  }, [items]);


  const [error, setError] = useState<string | null>(null);

  // Prevent race conditions when searches change quickly
  const requestIdRef = useRef(0);

  const limit = 20;

  const fetchPage = useCallback(
    async (opts: { mode: "initial" | "refresh" | "more" }) => {
      const requestId = ++requestIdRef.current;

      const isInitial = opts.mode === "initial";
      const isRefresh = opts.mode === "refresh";
      const isMore = opts.mode === "more";

      if (isInitial) setLoadingInitial(true);
      if (isRefresh) setRefreshing(true);
      if (isMore) setLoadingMore(true);

      setError(null);

      try {
        const cursorToUse = isMore ? nextCursorRef.current : null;

        const query = buildQuery({
          q,
          location,
          minBudget: minBudget ? parseInt(minBudget) : undefined,
          maxBudget: maxBudget ? parseInt(maxBudget) : undefined,
          limit,
          cursor: cursorToUse,
        });

        const data = await api.get<JobsBrowseResponse>(`/jobs/browse${query}`);

        // If a newer request started after this one, ignore this response
        if (requestId !== requestIdRef.current) return;

        setNextCursor(data.pageInfo?.nextCursor ?? null);

        if (isMore) {
          setItems((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const merged = [...prev];
            for (const j of data.items ?? []) {
              if (!seen.has(j.id)) merged.push(j);
            }
            return merged;
          });
        } else {
          setItems(data.items ?? []);
        }
      } catch (e: any) {
        if (requestId !== requestIdRef.current) return;
        setError(e?.message ?? "Failed to load jobs.");
      } finally {
        if (requestId !== requestIdRef.current) return;
        if (isInitial) setLoadingInitial(false);
        if (isRefresh) setRefreshing(false);
        if (isMore) setLoadingMore(false);
      }
    },
    [q, location, minBudget, maxBudget] // ✅ removed nextCursor
  );

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      fetchPage({ mode: "initial" });
    }, 400);
    return () => clearTimeout(t);
  }, [q, location, fetchPage]);

  // First load
  useEffect(() => {
    fetchPage({ mode: "initial" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(() => {
    fetchPage({ mode: "refresh" });
  }, [fetchPage]);

  const canLoadMore = useMemo(
    () =>
      !!nextCursor &&
      !loadingMore &&
      !loadingInitial &&
      !refreshing &&
      !error,
    [nextCursor, loadingMore, loadingInitial, refreshing, error]
  );

  const onEndReached = useCallback(() => {
    if (!canLoadMore) return;
    fetchPage({ mode: "more" });
  }, [canLoadMore, fetchPage]);

  const renderItem = ({ item, index }: { item: JobBrowseItem; index: number }) => {
    // Show interstitial ad every 5 items for free tier
    if (showInterstitialAds && index > 0 && index % 5 === 0) {
      showAd();
    }

    return (
      <View>
        <Pressable
          style={styles.card}
          onPress={() => router.push(`/job/${item.id}`)}
        >
          <View style={styles.cardTopRow}>
              <Text style={styles.title} numberOfLines={1}>
                  {item.title}
              </Text>

              <Pressable
                  onPress={(e) => {
                  e.stopPropagation?.(); // prevent card navigation
                  toggleFavorite(item.id);
                  }}
                  hitSlop={10}
                  style={styles.starBtn}
              >
                  <Text style={styles.starText}>{item.isFavorited ? "⭐" : "☆"}</Text>
              </Pressable>
          </View>


          {item.location ? (
            <Text style={styles.meta} numberOfLines={1}>
              📍 {item.location}
            </Text>
          ) : null}

          {item.category || item.urgency ? (
            <View style={styles.pillsRow}>
              {item.category ? (
                <View style={[styles.pill, styles.pillCategory]}>
                  <Text style={styles.pillText} numberOfLines={1}>
                    {item.category}
                  </Text>
                </View>
              ) : null}
              {item.urgency ? (
                <View style={[styles.pill, urgencyPillStyle(item.urgency)]}>
                  <Text style={styles.pillText} numberOfLines={1}>
                    {urgencyLabel(item.urgency)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.desc} numberOfLines={2}>
            {item.description ?? "No description provided."}
          </Text>

          <View style={styles.footerRow}>
            <Text style={styles.meta}>
              💰{" "}
              {item.budgetMin != null || item.budgetMax != null
                ? `${item.budgetMin ?? "?"} - ${item.budgetMax ?? "?"}`
                : "Budget not listed"}
            </Text>

            <Text style={styles.meta}>🧾 {item.bidCount} bids</Text>
          </View>

          <Text style={styles.metaSmall} numberOfLines={1}>
            Posted by: {item.consumer?.name ?? "Consumer"}
            {item.consumer?.location ? ` • ${item.consumer.location}` : ""}
          </Text>
        </Pressable>

        {showBannerAds &&
          inlineBannerEvery &&
          index > 0 &&
          index % inlineBannerEvery === 0 && (
            <BannerAdComponent placement="jobs_inline" style={{ marginVertical: 12 }} />
          )}
      </View>
    );
  };

  // Only providers should access this screen.
  if (!isProvider) {
    return <Redirect href="/" />;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Browse Jobs</Text>
        <Pressable
          style={styles.filterButton}
          onPress={() => setShowFiltersModal(true)}
        >
          <MaterialCommunityIcons name="tune" size={24} color="#38bdf8" />
          {(q || location || minBudget || maxBudget || selectedCategories.length > 0) && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>
                {(q ? 1 : 0) + (location ? 1 : 0) + (minBudget ? 1 : 0) + (maxBudget ? 1 : 0) + (selectedCategories.length > 0 ? 1 : 0)}
              </Text>
            </View>
          )}
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search title/description…"
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
        <TextInput
          value={location}
          onChangeText={setLocation}
          placeholder="Location…"
          placeholderTextColor="#94a3b8"
          style={styles.input}
        />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => fetchPage({ mode: "initial" })}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {loadingInitial ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading jobs…</Text>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            data={items}
            keyExtractor={(x) => String(x.id)}
            renderItem={renderItem}
            contentContainerStyle={
              items.length === 0 ? styles.emptyContainer : styles.listContainer
            }
            refreshing={refreshing}
            onRefresh={onRefresh}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.4}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.emptyText}>No jobs found.</Text>
                <Text style={styles.emptySubText}>
                  Try a different search or location.
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
          {showBannerAds && showFooterBanner && items.length > 0 && (
            <BannerAdComponent placement="jobs_footer" style={{ marginBottom: 8 }} />
          )}
        </View>
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
            <Text style={styles.modalTitle}>Filter Jobs</Text>
            <Pressable onPress={() => setShowFiltersModal(false)}>
              <MaterialCommunityIcons name="close" size={28} color="#fff" />
            </Pressable>
          </View>

          <ScrollView style={styles.modalContent}>
            {/* Budget Range */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Budget Range</Text>
              <View style={styles.budgetRow}>
                <TextInput
                  value={minBudget}
                  onChangeText={setMinBudget}
                  placeholder="Min"
                  placeholderTextColor="#94a3b8"
                  keyboardType="numeric"
                  style={[styles.input, styles.budgetInput]}
                />
                <Text style={styles.budgetDash}>–</Text>
                <TextInput
                  value={maxBudget}
                  onChangeText={setMaxBudget}
                  placeholder="Max"
                  placeholderTextColor="#94a3b8"
                  keyboardType="numeric"
                  style={[styles.input, styles.budgetInput]}
                />
              </View>
            </View>

            {/* Categories */}
            {categories.length > 0 && (
              <View style={styles.filterSection}>
                <Text style={styles.filterSectionTitle}>Categories</Text>
                <View style={styles.categoryGrid}>
                  {categories.map((cat) => {
                    const isSelected = selectedCategories.includes(cat.id);
                    return (
                      <Pressable
                        key={cat.id}
                        style={[
                          styles.categoryButton,
                          isSelected && styles.categoryButtonActive,
                        ]}
                        onPress={() => {
                          setSelectedCategories((prev) =>
                            isSelected
                              ? prev.filter((c) => c !== cat.id)
                              : [...prev, cat.id]
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
            {(q || location || minBudget || maxBudget || selectedCategories.length > 0) && (
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setQ("");
                  setLocation("");
                  setMinBudget("");
                  setMaxBudget("");
                  setSelectedCategories([]);
                }}
              >
                <Text style={styles.clearBtnText}>Clear All Filters</Text>
              </Pressable>
            )}
          </ScrollView>

          <Pressable
            style={styles.applyBtn}
            onPress={() => {
              setShowFiltersModal(false);
              fetchPage({ mode: "initial" });
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

  pillsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
    marginBottom: 4,
    flexWrap: "wrap",
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  pillText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  pillCategory: {
    backgroundColor: "#1d4ed8",
  },
  pillUrgent: {
    backgroundColor: "#dc2626",
  },
  pillSoon: {
    backgroundColor: "#f59e0b",
  },
  pillNormal: {
    backgroundColor: "#334155",
  },
  filterBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
  },

  searchRow: { paddingHorizontal: 16, gap: 10, marginBottom: 10 },
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
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  title: { color: "#fff", fontSize: 16, fontWeight: "800", flex: 1 },
  badge: {
    backgroundColor: "#1e293b",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  badgeText: { color: "#cbd5e1", fontSize: 12, fontWeight: "700" },

  meta: { color: "#cbd5e1", marginTop: 6, fontSize: 13 },
  desc: { color: "#e2e8f0", marginTop: 8, fontSize: 14, lineHeight: 19 },

  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    gap: 10,
  },
  metaSmall: { color: "#94a3b8", marginTop: 10, fontSize: 12 },

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

  starBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: "#1e293b",
  },
  starText: { color: "#fff", fontSize: 18, fontWeight: "800" },

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
  filterSectionTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },

  budgetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  budgetInput: { flex: 1 },
  budgetDash: { color: "#cbd5e1", fontSize: 18, fontWeight: "600" },

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
