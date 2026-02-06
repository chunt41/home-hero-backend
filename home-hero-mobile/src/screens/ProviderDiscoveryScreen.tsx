import React, { useState, useCallback, useEffect, useMemo } from "react";
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
import { router } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { MaterialCommunityIcons } from "@expo/vector-icons";

type ProviderItem = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  location: string | null;
  experience: string | null;
  specialties: string | null;
  rating: number | null;
  reviewCount: number;
  isFavorited: boolean;
  verificationStatus?: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  isVerified?: boolean;
  categories: { id: number; name: string; slug: string }[];
};

type ProvidersResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  providers: ProviderItem[];
};

type Category = {
  id: string;
  name: string;
  slug: string;
};

export default function ProviderDiscoveryScreen() {
  const [q, setQ] = useState("");
  const [location, setLocation] = useState("");
  const [minRating, setMinRating] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [showFiltersModal, setShowFiltersModal] = useState(false);

  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
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

  const fetchPage = useCallback(
    async (pageNum: number, mode: "initial" | "refresh" | "more") => {
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
        const query = new URLSearchParams();
        if (q) query.set("q", q);
        if (location) query.set("location", location);
        if (minRating) query.set("minRating", minRating);
        query.set("page", String(pageNum));
        query.set("pageSize", "15");

        const url = `/providers/search?${query.toString()}`;
        const res = (await api.get(url)) as ProvidersResponse;

        if (!res || !res.providers) {
          setError("No response from server");
          setProviders([]);
          return;
        }

        if (isMore) {
          setProviders((prev) => [...prev, ...res.providers]);
        } else {
          setProviders(res.providers);
        }

        setTotalPages(res.totalPages);
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
    [q, location, minRating]
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

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      fetchPage(1, "initial");
    }, 400);
    return () => clearTimeout(t);
  }, [q, location, minRating, selectedCategories, fetchPage]);

  // First load
  useEffect(() => {
    fetchPage(1, "initial");
  }, [fetchPage]);

  const onRefresh = useCallback(() => {
    setPage(1);
    fetchPage(1, "refresh");
  }, [fetchPage]);

  const onEndReached = useCallback(() => {
    if (page < totalPages && !loadingMore && !loadingInitial) {
      const nextPage = page + 1;
      setPage(nextPage);
      fetchPage(nextPage, "more");
    }
  }, [page, totalPages, loadingMore, loadingInitial, fetchPage]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (q) count++;
    if (location) count++;
    if (minRating) count++;
    if (selectedCategories.length) count++;
    return count;
  }, [q, location, minRating, selectedCategories]);

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
                {item.name}
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
          onPress={() => setShowFiltersModal(true)}
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
          value={q}
          onChangeText={setQ}
          placeholder="Search by name…"
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

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={() => fetchPage(1, "initial")}
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
            {/* Min Rating */}
            <View style={styles.filterSection}>
              <Text style={styles.filterSectionTitle}>Minimum Rating</Text>
              <View style={styles.ratingSelector}>
                {[3, 3.5, 4, 4.5, 5].map((rating) => (
                  <Pressable
                    key={rating}
                    style={[
                      styles.ratingButton,
                      minRating === String(rating) && styles.ratingButtonActive,
                    ]}
                    onPress={() =>
                      setMinRating(
                        minRating === String(rating) ? "" : String(rating)
                      )
                    }
                  >
                    <Text
                      style={[
                        styles.ratingButtonText,
                        minRating === String(rating) &&
                          styles.ratingButtonTextActive,
                      ]}
                    >
                      {rating}★+
                    </Text>
                  </Pressable>
                ))}
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
            {activeFilterCount > 0 && (
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setQ("");
                  setLocation("");
                  setMinRating("");
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
              setPage(1);
              fetchPage(1, "initial");
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
