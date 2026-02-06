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
import { useFocusEffect, router } from "expo-router";
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

export default function ProviderDashboardScreen() {
  const { stats, loading, error, fetch } = useProviderStats();
  const [refreshing, setRefreshing] = useState(false);

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

  if (loading && !stats) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={styles.loadingText}>Loading your dashboard…</Text>
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
        <Text style={styles.errorTitle}>Couldn’t load dashboard</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={fetch}
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <FlatList
        data={stats?.recentBids ?? []}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Your Dashboard</Text>

            {/* Stats Row */}
            <View style={styles.statsGrid}>
              <StatCard
                label="Total Bids"
                value={String(stats?.totalBids ?? 0)}
                icon="briefcase"
                color={COLORS.accent}
              />
              <StatCard
                label="Active"
                value={String(stats?.activeBids ?? 0)}
                icon="clock-outline"
                color={COLORS.warning}
              />
              <StatCard
                label="Accepted"
                value={String(stats?.acceptedBids ?? 0)}
                icon="check-circle"
                color={COLORS.success}
              />
            </View>

            {/* Browse & Manage Buttons */}
            <View style={styles.actionButtons}>
              <Pressable
                style={[styles.actionButton, styles.primaryButton]}
                onPress={() => router.push("/(tabs)/jobs")}
              >
                <MaterialCommunityIcons name="magnify" size={18} color="#020617" />
                <Text style={styles.primaryButtonText}>Browse Jobs</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.secondaryButton]}
                onPress={() => router.push("/provider/my-bids")}
              >
                <MaterialCommunityIcons name="list-box" size={18} color={COLORS.accent} />
                <Text style={styles.secondaryButtonText}>My Bids</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.secondaryButton]}
                onPress={() => router.push("/provider/earnings")}
              >
                <MaterialCommunityIcons name="currency-usd" size={18} color={COLORS.accent} />
                <Text style={styles.secondaryButtonText}>Earnings</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.secondaryButton]}
                onPress={() => router.push("/provider/analytics")}
              >
                <MaterialCommunityIcons name="chart-line" size={18} color={COLORS.accent} />
                <Text style={styles.secondaryButtonText}>Analytics</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.secondaryButton]}
                onPress={() => router.push("/provider/subscription")}
              >
                <MaterialCommunityIcons name="star" size={18} color={COLORS.accent} />
                <Text style={styles.secondaryButtonText}>Plans</Text>
              </Pressable>
              <Pressable
                style={[styles.actionButton, styles.secondaryButton]}
                onPress={() => router.push("/provider/profile")}
              >
                <MaterialCommunityIcons name="account-edit" size={18} color={COLORS.accent} />
                <Text style={styles.secondaryButtonText}>Profile</Text>
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>Recent Bids</Text>
          </View>
        }
        renderItem={({ item }) => <BidRow bid={item} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <MaterialCommunityIcons
              name="inbox-outline"
              size={48}
              color={COLORS.textMuted}
            />
            <Text style={styles.emptyText}>No bids yet</Text>
            <Text style={styles.emptySubtext}>
              Browse jobs and place your first bid
            </Text>
          </View>
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        scrollEnabled={true}
        contentContainerStyle={stats?.recentBids?.length === 0 ? { flexGrow: 1 } : undefined}
      />
    </SafeAreaView>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  color: string;
}) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: color + "15" }]}>
        <MaterialCommunityIcons
          name={icon as any}
          size={24}
          color={color}
        />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function BidRow({ bid }: { bid: ProviderBid }) {
  const statusColor = getStatusColor(bid.status);

  const handlePress = () => {
    router.push({
      pathname: "/provider/bid-detail",
      params: { bidId: String(bid.id), jobId: String(bid.job.id) },
    });
  };

  return (
    <Pressable style={styles.bidRow} onPress={handlePress}>
      <View style={styles.bidContent}>
        <Text style={styles.jobTitle} numberOfLines={1}>
          {bid.job.title}
        </Text>
        <Text style={styles.bidAmount}>${bid.amount.toFixed(2)}</Text>
        {bid.job.location && (
          <Text style={styles.location} numberOfLines={1}>
            📍 {bid.job.location}
          </Text>
        )}
      </View>
      <View style={styles.bidRight}>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + "20" }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>
            {bid.status}
          </Text>
        </View>
        <MaterialCommunityIcons
          name="chevron-right"
          size={20}
          color={COLORS.textMuted}
        />
      </View>
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
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: COLORS.text,
  },

  statsGrid: {
    flexDirection: "row",
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
  },
  statValue: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
  },
  statLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
  },

  actionButtons: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  actionButton: {
    flex: 1,
    minWidth: "31%",
    flexDirection: "row",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
  },
  primaryButtonText: {
    color: COLORS.bg,
    fontWeight: "600",
    fontSize: 12,
  },
  secondaryButton: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  secondaryButtonText: {
    color: COLORS.accent,
    fontWeight: "600",
    fontSize: 12,
  },

  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: COLORS.text,
    marginTop: 8,
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

  separator: {
    height: 1,
    backgroundColor: COLORS.border,
    marginHorizontal: 16,
  },

  bidRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  bidContent: {
    flex: 1,
    gap: 4,
  },
  jobTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: COLORS.text,
  },
  bidAmount: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.accent,
  },
  location: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  bidRight: {
    alignItems: "flex-end",
    gap: 8,
  },
  statusBadge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
