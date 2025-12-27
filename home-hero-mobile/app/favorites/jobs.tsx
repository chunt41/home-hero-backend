import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { api } from "../../src/lib/apiClient";

type FavoriteJobRow = {
  favoritedAt: string;
  job: {
    id: number;
    title: string;
    description: string | null;
    budgetMin: number | null;
    budgetMax: number | null;
    status: string;
    location: string | null;
    createdAt: string;
    isFavorited: boolean;
    consumer: { id: number; name: string | null; location: string | null };
  };
};

export default function FavoriteJobsScreen() {
  const [items, setItems] = useState<FavoriteJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFavorites = useCallback(async (mode: "initial" | "refresh") => {
    try {
      if (mode === "initial") setLoading(true);
      if (mode === "refresh") setRefreshing(true);
      setError(null);

      const data = await api.get<FavoriteJobRow[]>("/me/favorites/jobs");
      setItems(data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load favorites.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchFavorites("initial");
    }, [fetchFavorites])
  );

  const unfavorite = useCallback(
    async (jobId: number) => {
      // optimistic UI
      const prev = items;
      setItems((cur) => cur.filter((x) => x.job.id !== jobId));
      try {
        await api.delete(`/jobs/${jobId}/favorite`);
      } catch (e) {
        // rollback if it failed
        setItems(prev);
      }
    },
    [items]
  );

  const renderItem = ({ item }: { item: FavoriteJobRow }) => {
    const job = item.job;

    return (
      <Pressable style={styles.card} onPress={() => router.push(`/job/${job.id}`)}>
        <View style={styles.cardTopRow}>
          <Text style={styles.title} numberOfLines={1}>
            {job.title}
          </Text>

          <Pressable
            onPress={() => unfavorite(job.id)}
            hitSlop={10}
            style={styles.unfavBtn}
          >
            <Text style={styles.unfavText}>♥</Text>
          </Pressable>
        </View>

        {job.location ? (
          <Text style={styles.meta} numberOfLines={1}>
            📍 {job.location}
          </Text>
        ) : null}

        <Text style={styles.desc} numberOfLines={2}>
          {job.description ?? "No description provided."}
        </Text>

        <View style={styles.footerRow}>
          <Text style={styles.meta}>
            💰{" "}
            {job.budgetMin != null || job.budgetMax != null
              ? `${job.budgetMin ?? "?"} - ${job.budgetMax ?? "?"}`
              : "Budget not listed"}
          </Text>

          <View style={styles.badge}>
            <Text style={styles.badgeText}>{job.status}</Text>
          </View>
        </View>

        <Text style={styles.metaSmall} numberOfLines={1}>
          Posted by: {job.consumer?.name ?? "Consumer"}
          {job.consumer?.location ? ` • ${job.consumer.location}` : ""}
        </Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <Text style={styles.screenTitle}>Saved Jobs</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.meta}>Loading favorites…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => fetchFavorites("initial")}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(x) => String(x.job.id)}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: 16 }}
          onRefresh={() => fetchFavorites("refresh")}
          refreshing={refreshing}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.meta}>No saved jobs yet.</Text>
              <Text style={styles.metaSmall}>
                Tap ♥ on Browse Jobs to save a job.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220", paddingHorizontal: 14 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6,
    paddingBottom: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  backText: { color: "#e5e7eb", fontSize: 18, fontWeight: "800" },
  screenTitle: { color: "#e5e7eb", fontSize: 20, fontWeight: "800" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  meta: { color: "#cbd5e1" },
  metaSmall: { color: "#94a3b8" },
  errorText: { color: "#fca5a5" },

  retryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "800" },

  card: {
    marginBottom: 10,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  cardTopRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flex: 1, color: "#e5e7eb", fontWeight: "800", fontSize: 16 },

  unfavBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  unfavText: { color: "#fb7185", fontWeight: "900", fontSize: 16 },

  desc: { color: "#cbd5e1", marginTop: 6, marginBottom: 8, lineHeight: 18 },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  badge: {
    backgroundColor: "#0ea5e9",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: { color: "#020617", fontWeight: "900", fontSize: 12 },
});
