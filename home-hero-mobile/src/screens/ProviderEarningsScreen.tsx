import React, { useCallback } from "react";
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useProviderEarnings } from "../hooks/useProviderEarnings";
import { formatDistanceToNow } from "date-fns";

export default function ProviderEarningsScreen() {
  const router = useRouter();
  const { summary, loading, error, refetch } = useProviderEarnings();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const renderStatCard = (
    icon: string,
    label: string,
    value: string | number,
    color: string
  ) => (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: `${color}20` }]}>
        <MaterialCommunityIcons name={icon as any} size={24} color={color} />
      </View>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );

  const renderEarningsItem = ({ item }: { item: any }) => (
    <Pressable
      style={styles.earningsCard}
      onPress={() => router.push(`/job/${item.jobId}`)}
    >
      <View style={styles.earningsCardHeader}>
        <Text style={styles.jobTitle} numberOfLines={2}>
          {item.jobTitle}
        </Text>
        <Text style={styles.amount}>${item.bidAmount.toFixed(2)}</Text>
      </View>

      <View style={styles.earningsCardMeta}>
        <Text style={styles.metaText} numberOfLines={1}>
          📍 {item.consumerName}
        </Text>
        {item.completedAt && (
          <Text style={styles.metaText}>
            ✓ {formatDistanceToNow(new Date(item.completedAt), { addSuffix: true })}
          </Text>
        )}
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.screenTitle}>Earnings & History</Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={refetch}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading earnings...</Text>
        </View>
      ) : (
        <FlatList
          data={summary?.earnings || []}
          keyExtractor={(item) => String(item.jobId)}
          ListHeaderComponent={
            summary ? (
              <View style={styles.statsSection}>
                <View style={styles.statsGrid}>
                  {renderStatCard(
                    "currency-usd",
                    "Total Earnings",
                    `$${summary.totalEarnings.toFixed(2)}`,
                    "#10b981"
                  )}
                  {renderStatCard(
                    "briefcase",
                    "Completed Jobs",
                    summary.completedJobs,
                    "#3b82f6"
                  )}
                </View>

                <View style={styles.statsGrid}>
                  {renderStatCard(
                    "hand-raised",
                    "Accepted Bids",
                    summary.acceptedBids,
                    "#f59e0b"
                  )}
                  {renderStatCard(
                    "chart-line",
                    "Avg per Job",
                    `$${summary.averageEarningsPerJob.toFixed(2)}`,
                    "#8b5cf6"
                  )}
                </View>

                {summary.earnings.length > 0 && (
                  <View style={styles.jobHistoryHeader}>
                    <Text style={styles.jobHistoryTitle}>Job History</Text>
                  </View>
                )}
              </View>
            ) : null
          }
          renderItem={renderEarningsItem}
          contentContainerStyle={styles.listContent}
          onRefresh={refetch}
          refreshing={false}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.emptyContent}>
                <MaterialCommunityIcons
                  name="briefcase-off"
                  size={48}
                  color="#64748b"
                />
                <Text style={styles.emptyText}>No earnings yet</Text>
                <Text style={styles.emptySubText}>
                  Complete accepted jobs to earn money
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#020617",
  },

  screenTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "800",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },

  errorBox: {
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    color: "#fca5a5",
    marginBottom: 10,
    fontSize: 14,
  },
  retryBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#38bdf8",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  retryText: {
    color: "#020617",
    fontWeight: "800",
    fontSize: 12,
  },

  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: "#cbd5e1",
    marginTop: 12,
  },

  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  statsSection: {
    marginBottom: 20,
  },

  statsGrid: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },

  statCard: {
    flex: 1,
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
  },

  statIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },

  statLabel: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 6,
  },

  statValue: {
    color: "#e2e8f0",
    fontSize: 18,
    fontWeight: "800",
    textAlign: "center",
  },

  jobHistoryHeader: {
    marginTop: 20,
    marginBottom: 12,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
    paddingTop: 16,
  },

  jobHistoryTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
  },

  earningsCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  earningsCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
    gap: 12,
  },

  jobTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },

  amount: {
    color: "#10b981",
    fontSize: 16,
    fontWeight: "800",
  },

  earningsCardMeta: {
    gap: 6,
  },

  metaText: {
    color: "#cbd5e1",
    fontSize: 12,
  },

  emptyContent: {
    alignItems: "center",
    paddingVertical: 40,
  },

  emptyText: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 16,
  },

  emptySubText: {
    color: "#94a3b8",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },
});
