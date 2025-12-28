import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect, Redirect } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { useAuth } from "../../src/context/AuthContext";
import { useAdConfig } from "../../src/hooks/useAdConfig";
import { useInterstitialAd } from "../../src/hooks/useInterstitialAd";
import { BannerAdComponent } from "../../src/components/BannerAdComponent";

type ConsumerJobItem = {
  id: number;
  title: string;
  status: string; // "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | ...
  location: string | null;
  createdAt: string;
  bidCount: number;
};

type FilterKey =
  | "ACTIVE"
  | "OPEN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "ALL";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ACTIVE", label: "Active" },
  { key: "OPEN", label: "Open" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "COMPLETED", label: "Completed" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "ALL", label: "All" },
];

function normalizeStatus(s: string | null | undefined) {
  return (s ?? "").toUpperCase().trim();
}

export default function ConsumerJobsScreen() {
  const { user } = useAuth();
  const { showBannerAds, showInterstitialAds, inlineBannerEvery, showFooterBanner } =
    useAdConfig();
  const { showAd } = useInterstitialAd(showInterstitialAds);

  // Only consumers should access this screen
  if (user?.role !== "CONSUMER") {
    return <Redirect href="/" />;
  }
  const [items, setItems] = useState<ConsumerJobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobIndex, setJobIndex] = useState(0);

  const [filter, setFilter] = useState<FilterKey>("ACTIVE");

  const fetchJobs = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    setError(null);

    try {
      const data = await api.get<ConsumerJobItem[]>(`/consumer/jobs`);
      setItems(data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load your jobs.");
      setItems([]);
    } finally {
      if (mode === "initial") setLoading(false);
      if (mode === "refresh") setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs("initial");
  }, [fetchJobs]);

  useFocusEffect(
    useCallback(() => {
      fetchJobs("refresh");
    }, [fetchJobs])
  );

  const onRefresh = useCallback(() => {
    fetchJobs("refresh");
  }, [fetchJobs]);

  const filteredItems = useMemo(() => {
    const norm = items.map((j) => ({ ...j, status: normalizeStatus(j.status) }));

    switch (filter) {
      case "ACTIVE":
        return norm.filter((j) => j.status === "OPEN" || j.status === "IN_PROGRESS");
      case "OPEN":
        return norm.filter((j) => j.status === "OPEN");
      case "IN_PROGRESS":
        return norm.filter((j) => j.status === "IN_PROGRESS");
      case "COMPLETED":
        return norm.filter((j) => j.status === "COMPLETED");
      case "CANCELLED":
        return norm.filter((j) => j.status === "CANCELLED");
      case "ALL":
      default:
        return norm;
    }
  }, [items, filter]);

  const counts = useMemo(() => {
    const c = {
      OPEN: 0,
      IN_PROGRESS: 0,
      COMPLETED: 0,
      CANCELLED: 0,
      ALL: items.length,
      ACTIVE: 0,
    };

    for (const j of items) {
      const s = normalizeStatus(j.status);
      if (s === "OPEN") c.OPEN++;
      else if (s === "IN_PROGRESS") c.IN_PROGRESS++;
      else if (s === "COMPLETED") c.COMPLETED++;
      else if (s === "CANCELLED") c.CANCELLED++;
    }
    c.ACTIVE = c.OPEN + c.IN_PROGRESS;
    return c;
  }, [items]);

  const emptyText = useMemo(() => {
    if (filter === "ACTIVE") return "No active jobs right now.";
    if (filter === "OPEN") return "No OPEN jobs.";
    if (filter === "IN_PROGRESS") return "No jobs IN_PROGRESS.";
    if (filter === "COMPLETED") return "No COMPLETED jobs yet.";
    if (filter === "CANCELLED") return "No CANCELLED jobs.";
    return "No jobs yet.";
  }, [filter]);

  const renderItem = ({ item, index }: { item: ConsumerJobItem; index: number }) => {
    // Show interstitial ad every 5 items for free tier
    if (showInterstitialAds && index > 0 && index % 5 === 0) {
      showAd();
    }

    return (
      <View>
        <Pressable style={styles.card} onPress={() => router.push(`/consumer/job/${item.id}`)}>
          <View style={styles.topRow}>
            <Text style={styles.title} numberOfLines={1}>
              {item.title}
            </Text>

            <View style={styles.badge}>
              <Text style={styles.badgeText}>{normalizeStatus(item.status)}</Text>
            </View>
          </View>

          {item.location ? (
            <Text style={styles.meta} numberOfLines={1}>
              📍 {item.location}
            </Text>
          ) : null}

          <Text style={styles.meta}>🧾 {item.bidCount} bids</Text>
        </Pressable>

        {item.bidCount > 0 && (
          <Pressable
            style={styles.viewBidsButton}
            onPress={() => router.push(`/consumer/job-bids?jobId=${item.id}`)}
          >
            <Text style={styles.viewBidsButtonText}>View {item.bidCount} Bid{item.bidCount !== 1 ? 's' : ''}</Text>
          </Pressable>
        )}

        {showBannerAds &&
          inlineBannerEvery &&
          index > 0 &&
          index % inlineBannerEvery === 0 && (
            <BannerAdComponent
              placement="consumer_jobs_inline"
              style={{ marginVertical: 12 }}
            />
          )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.screenTitle}>My Jobs</Text>

      {/* Filter pills */}
      <View style={styles.filtersWrap}>
        {FILTERS.map((f) => {
          const isActive = f.key === filter;

          const count =
            f.key === "ACTIVE"
              ? counts.ACTIVE
              : f.key === "OPEN"
              ? counts.OPEN
              : f.key === "IN_PROGRESS"
              ? counts.IN_PROGRESS
              : f.key === "COMPLETED"
              ? counts.COMPLETED
              : f.key === "CANCELLED"
              ? counts.CANCELLED
              : counts.ALL;

          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.filterPill, isActive && styles.filterPillActive]}
            >
              <Text style={[styles.filterText, isActive && styles.filterTextActive]}>
                {f.label}{" "}
                <Text style={[styles.filterCount, isActive && styles.filterCountActive]}>
                  {count}
                </Text>
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actionRow}>
        <Pressable onPress={() => router.push("/consumer/create-job")} style={styles.createBtn}>
          <Text style={styles.createBtnText}>+ Post Job</Text>
        </Pressable>
        <Pressable onPress={() => router.push("/consumer/providers")} style={styles.browseBtn}>
          <Text style={styles.browseBtnText}>🔍 Find Providers</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading your jobs…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => fetchJobs("initial")}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            data={filteredItems}
            keyExtractor={(x) => String(x.id)}
            renderItem={renderItem}
            contentContainerStyle={filteredItems.length ? styles.list : styles.empty}
            refreshing={refreshing}
            onRefresh={onRefresh}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.muted}>{emptyText}</Text>
                {filter !== "ALL" ? (
                  <Pressable onPress={() => setFilter("ALL")} style={styles.smallBtn}>
                    <Text style={styles.smallBtnText}>View All</Text>
                  </Pressable>
                ) : null}
              </View>
            }
          />
          {showBannerAds && showFooterBanner && filteredItems.length > 0 && (
            <BannerAdComponent
              placement="consumer_jobs_footer"
              style={{ marginBottom: 8 }}
            />
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },
  screenTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
  },

  filtersWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  filterPill: {
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#111827",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  filterPillActive: {
    backgroundColor: "#38bdf8",
    borderColor: "#38bdf8",
  },
  filterText: { color: "#cbd5e1", fontWeight: "900", fontSize: 12 },
  filterTextActive: { color: "#020617" },
  filterCount: { color: "#94a3b8", fontWeight: "900" },
  filterCountActive: { color: "#020617" },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  muted: { color: "#cbd5e1", marginTop: 10 },
  error: { color: "#fca5a5", textAlign: "center", marginBottom: 12 },

  retryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "900" },

  list: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { flexGrow: 1, justifyContent: "center", padding: 16 },

  card: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  title: { color: "#fff", fontSize: 16, fontWeight: "900", flex: 1 },

  badge: { backgroundColor: "#1e293b", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  badgeText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },

  meta: { color: "#cbd5e1", marginTop: 8 },

  viewBidsButton: {
    backgroundColor: "#1e293b",
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  viewBidsButtonText: {
    color: "#38bdf8",
    fontWeight: "700",
    fontSize: 13,
  },

  actionRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    marginBottom: 8,
  },

  createBtn: {
    flex: 1,
    backgroundColor: "#38bdf8",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  createBtnText: {
    color: "#020617",
    fontWeight: "900",
    fontSize: 14,
  },

  browseBtn: {
    flex: 1,
    backgroundColor: "#1e293b",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  browseBtnText: {
    color: "#38bdf8",
    fontWeight: "900",
    fontSize: 14,
  },

  smallBtn: {
    marginTop: 12,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#334155",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  smallBtnText: { color: "#e2e8f0", fontWeight: "900" },
});
