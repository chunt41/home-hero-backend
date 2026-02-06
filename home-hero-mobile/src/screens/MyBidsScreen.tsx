import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useProviderStats, type ProviderBid } from "../hooks/useProviderStats";

const COLORS = {
  bg: "#0f172a",
  card: "#1e293b",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#38bdf8",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  border: "#334155",
};

export default function MyBidsScreen() {
  const { stats, loading, error, fetch } = useProviderStats();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      fetch();
    }, [fetch])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetch();
    setRefreshing(false);
  }, [fetch]);

  const allBids = stats?.recentBids ?? [];
  const filteredBids = filter
    ? allBids.filter((b) => b.status === filter)
    : allBids;

  const filters = [
    { label: "All", value: null },
    { label: "Pending", value: "PENDING" },
    { label: "Accepted", value: "ACCEPTED" },
    { label: "Rejected", value: "REJECTED" },
  ];

  if (loading && !stats) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Loading your bids…</Text>
      </View>
    );
  }

  if (error && !stats) {
    return (
      <View style={styles.centerContainer}>
        <MaterialCommunityIcons
          name="alert-circle-outline"
          size={48}
          color={COLORS.danger}
        />
        <Text style={styles.errorTitle}>Couldn’t load bids</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={fetch}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <FlatList
        data={filteredBids}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <Pressable onPress={() => router.back()}>
                <MaterialCommunityIcons
                  name="chevron-left"
                  size={24}
                  color={COLORS.accent}
                />
              </Pressable>
              <Text style={styles.title}>My Bids</Text>
              <View style={{ width: 24 }} />
            </View>

            <Text style={styles.subtitle}>
              You have {allBids.length} bid{allBids.length !== 1 ? "s" : ""}
            </Text>

            {/* Filter Buttons */}
            <View style={styles.filterContainer}>
              {filters.map((f) => (
                <Pressable
                  key={f.value ?? "all"}
                  style={[
                    styles.filterButton,
                    filter === f.value && styles.filterButtonActive,
                  ]}
                  onPress={() => setFilter(f.value)}
                >
                  <Text
                    style={[
                      styles.filterButtonText,
                      filter === f.value && styles.filterButtonTextActive,
                    ]}
                  >
                    {f.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        renderItem={({ item }) => <BidCard bid={item} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="inbox-outline"
              size={48}
              color={COLORS.textMuted}
            />
            <Text style={styles.emptyText}>
              {filter ? "No bids with this status" : "No bids yet"}
            </Text>
            <Text style={styles.emptySubtext}>
              {filter
                ? "Try a different filter"
                : "Browse jobs and place your first bid"}
            </Text>
          </View>
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </SafeAreaView>
  );
}

function BidCard({ bid }: { bid: ProviderBid }) {
  const router = useRouter();
  const statusColor = getStatusColor(bid.status);
  const createdDate = new Date(bid.createdAt).toLocaleDateString();

  const handlePress = () => {
    router.push({
      pathname: "/provider/bid-detail",
      params: { bidId: String(bid.id), jobId: String(bid.job.id) },
    });
  };

  return (
    <Pressable style={styles.bidCard} onPress={handlePress}>
      <View style={styles.bidHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.jobTitle} numberOfLines={2}>
            {bid.job.title}
          </Text>
          <Text style={styles.createdDate}>{createdDate}</Text>
        </View>
        <View
          style={[styles.statusBadge, { backgroundColor: statusColor + "25" }]}
        >
          <Text style={[styles.statusText, { color: statusColor }]}>
            {bid.status}
          </Text>
        </View>
      </View>

      <View style={styles.bidDetails}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Your Bid</Text>
          <Text style={styles.bidAmount}>${bid.amount.toFixed(2)}</Text>
        </View>

        {bid.message && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Message</Text>
            <Text style={styles.detailValue} numberOfLines={2}>
              {bid.message}
            </Text>
          </View>
        )}

        {bid.job.location && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Location</Text>
            <Text style={styles.detailValue}>{bid.job.location}</Text>
          </View>
        )}

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Job Status</Text>
          <Text style={styles.detailValue}>{bid.job.status}</Text>
        </View>
      </View>

      <Pressable style={styles.viewButton}>
        <Text style={styles.viewButtonText}>View Details</Text>
        <MaterialCommunityIcons
          name="chevron-right"
          size={16}
          color={COLORS.accent}
        />
      </Pressable>
    </Pressable>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case "ACCEPTED":
      return COLORS.success;
    case "PENDING":
      return COLORS.warning;
    case "REJECTED":
    case "WITHDRAWN":
      return COLORS.danger;
    default:
      return COLORS.accent;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  centerContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  loadingText: {
    color: COLORS.textMuted,
    marginTop: 12,
    fontSize: 14,
  },
  errorTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 12,
  },
  errorText: {
    color: COLORS.textMuted,
    marginTop: 8,
    textAlign: "center",
  },
  retryButton: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: COLORS.accent,
    borderRadius: 8,
  },
  retryButtonText: {
    color: COLORS.bg,
    fontWeight: "600",
  },

  header: {
    padding: 16,
    gap: 16,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textMuted,
  },

  filterContainer: {
    flexDirection: "row",
    gap: 8,
  },
  filterButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterButtonActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  filterButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: COLORS.textMuted,
  },
  filterButtonTextActive: {
    color: COLORS.bg,
  },

  separator: {
    height: 1,
    backgroundColor: COLORS.border,
    marginHorizontal: 16,
  },

  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 48,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: "600",
    color: COLORS.text,
  },
  emptySubtext: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: "center",
    paddingHorizontal: 16,
  },

  bidCard: {
    backgroundColor: COLORS.card,
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },
  bidHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  jobTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: COLORS.text,
  },
  createdDate: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 4,
  },
  statusBadge: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "700",
  },

  bidDetails: {
    gap: 8,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  detailLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: "500",
  },
  bidAmount: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.accent,
  },
  detailValue: {
    fontSize: 13,
    color: COLORS.text,
    fontWeight: "500",
    flex: 1,
    textAlign: "right",
  },

  viewButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    marginTop: 4,
  },
  viewButtonText: {
    color: COLORS.accent,
    fontWeight: "600",
    fontSize: 13,
    marginRight: 4,
  },
});
