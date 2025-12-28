import React, { useCallback } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useProviderAnalytics } from "../hooks/useProviderAnalytics";

const COLORS = {
  bg: "#020617",
  card: "#0f172a",
  border: "#1e293b",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#38bdf8",
  success: "#10b981",
  warning: "#f59e0b",
};

const { width } = Dimensions.get("window");
const cardWidth = (width - 40) / 2; // 16px padding on each side, gap between

export default function AnalyticsDashboardScreen() {
  const { analytics, loading, error, refetch } = useProviderAnalytics();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Analytics</Text>
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading analytics…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !analytics) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Analytics</Text>
        </View>
        <View style={styles.center}>
          <MaterialCommunityIcons
            name="alert-circle"
            size={48}
            color={COLORS.accent}
          />
          <Text style={styles.errorText}>{error || "No data available"}</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Analytics</Text>
      </View>

      <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Summary Cards */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Key Metrics</Text>

          <View style={styles.metricsGridRows}>
            <View style={styles.metricsRow}>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="cash"
                    size={20}
                    color={COLORS.success}
                  />
                  <Text style={styles.metricLabel}>Total Earnings</Text>
                </View>
                <Text style={styles.metricValue}>
                  ${analytics.totalEarnings.toFixed(0)}
                </Text>
              </View>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="check-circle"
                    size={20}
                    color={COLORS.accent}
                  />
                  <Text style={styles.metricLabel}>Jobs Completed</Text>
                </View>
                <Text style={styles.metricValue}>{analytics.completedJobs}</Text>
              </View>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="handshake"
                    size={20}
                    color={COLORS.warning}
                  />
                  <Text style={styles.metricLabel}>Accepted Bids</Text>
                </View>
                <Text style={styles.metricValue}>{analytics.acceptedBids}</Text>
              </View>
            </View>
            <View style={styles.metricsRow}>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="percent"
                    size={20}
                    color={COLORS.accent}
                  />
                  <Text style={styles.metricLabel}>Acceptance Rate</Text>
                </View>
                <Text style={styles.metricValue}>
                  {analytics.bidAcceptanceRate}%
                </Text>
              </View>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="clock-outline"
                    size={20}
                    color={COLORS.textMuted}
                  />
                  <Text style={styles.metricLabel}>Pending Bids</Text>
                </View>
                <Text style={styles.metricValue}>{analytics.pendingBids}</Text>
              </View>
              <View style={styles.metricCard}>
                <View style={styles.metricHeader}>
                  <MaterialCommunityIcons
                    name="trending-up"
                    size={20}
                    color={COLORS.success}
                  />
                  <Text style={styles.metricLabel}>Avg per Job</Text>
                </View>
                <Text style={styles.metricValue}>
                  ${analytics.averageEarningsPerJob.toFixed(0)}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Bid Status Breakdown */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bid Status Breakdown</Text>

          <View style={styles.bidStatusContainer}>
            <View style={styles.bidStatusRow}>
              <View style={styles.bidStatusItem}>
                <View
                  style={[styles.bidStatusDot, { backgroundColor: COLORS.accent }]}
                />
                <Text style={styles.bidStatusLabel}>Accepted</Text>
                <Text style={styles.bidStatusValue}>
                  {analytics.bidStats.accepted}
                </Text>
              </View>

              <View style={styles.bidStatusItem}>
                <View
                  style={[
                    styles.bidStatusDot,
                    { backgroundColor: COLORS.warning },
                  ]}
                />
                <Text style={styles.bidStatusLabel}>Pending</Text>
                <Text style={styles.bidStatusValue}>
                  {analytics.bidStats.pending}
                </Text>
              </View>

              <View style={styles.bidStatusItem}>
                <View
                  style={[
                    styles.bidStatusDot,
                    { backgroundColor: "#ef4444" },
                  ]}
                />
                <Text style={styles.bidStatusLabel}>Declined</Text>
                <Text style={styles.bidStatusValue}>
                  {analytics.bidStats.declined}
                </Text>
              </View>
            </View>

            {/* Simple bar chart representation */}
            <View style={styles.bidChart}>
              {analytics.bidStats.total > 0 ? (
                <>
                  <View style={styles.chartBar}>
                    <View
                      style={[
                        styles.chartSegment,
                        {
                          width: `${
                            (analytics.bidStats.accepted /
                              analytics.bidStats.total) *
                            100
                          }%`,
                          backgroundColor: COLORS.accent,
                        },
                      ]}
                    />
                    <View
                      style={[
                        styles.chartSegment,
                        {
                          width: `${
                            (analytics.bidStats.pending /
                              analytics.bidStats.total) *
                            100
                          }%`,
                          backgroundColor: COLORS.warning,
                        },
                      ]}
                    />
                    <View
                      style={[
                        styles.chartSegment,
                        {
                          width: `${
                            (analytics.bidStats.declined /
                              analytics.bidStats.total) *
                            100
                          }%`,
                          backgroundColor: "#ef4444",
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.chartLabel}>
                    Total Bids: {analytics.bidStats.total}
                  </Text>
                </>
              ) : (
                <Text style={styles.noDataText}>No bid data yet</Text>
              )}
            </View>
          </View>
        </View>

        {/* Earnings Trend (Last 6 months) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Earnings Trend (6 Months)</Text>

          <View style={styles.earningsChart}>
            {analytics.earningsByMonth.length > 0 ? (
              <View style={styles.monthsContainer}>
                {analytics.earningsByMonth.map((item, idx) => {
                  const maxEarnings = Math.max(
                    ...analytics.earningsByMonth.map((m) => m.earnings),
                    1
                  );
                  const height =
                    ((item.earnings / maxEarnings) * 120) || 20; // Min height 20

                  return (
                    <View key={idx} style={styles.monthBar}>
                      <View style={styles.barContainer}>
                        <View
                          style={[
                            styles.bar,
                            { height: Math.max(height, 10) },
                          ]}
                        />
                      </View>
                      <Text style={styles.monthLabel}>{item.month}</Text>
                      <Text style={styles.monthValue}>
                        ${item.earnings.toFixed(0)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.noDataText}>No earnings yet</Text>
            )}
          </View>
        </View>

        {/* Jobs by Category */}
        {analytics.jobsByCategory.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Jobs by Category</Text>

            <View style={styles.categoryList}>
              {analytics.jobsByCategory.map((cat, idx) => (
                <View key={idx} style={styles.categoryItem}>
                  <View style={styles.categoryInfo}>
                    <Text style={styles.categoryName}>{cat.name}</Text>
                    <View style={styles.categoryBar}>
                      <View
                        style={[
                          styles.categoryBarFill,
                          {
                            width: `${
                              (cat.count /
                                Math.max(
                                  ...analytics.jobsByCategory.map((c) => c.count)
                                )) *
                              100
                            }%`,
                          },
                        ]}
                      />
                    </View>
                  </View>
                  <Text style={styles.categoryCount}>{cat.count}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Recent Jobs */}
        {analytics.recentJobs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent Jobs</Text>

            <View style={styles.recentJobsList}>
              {analytics.recentJobs.map((job, idx) => (
                <View
                  key={idx}
                  style={[
                    styles.recentJobCard,
                    idx === analytics.recentJobs.length - 1 &&
                      styles.lastRecentJob,
                  ]}
                >
                  <View style={styles.jobHeader}>
                    <Text style={styles.jobTitle} numberOfLines={1}>
                      {job.title}
                    </Text>
                    <Text
                      style={[
                        styles.jobStatus,
                        {
                          color:
                            job.status === "COMPLETED"
                              ? COLORS.success
                              : job.status === "IN_PROGRESS"
                              ? COLORS.warning
                              : COLORS.textMuted,
                        },
                      ]}
                    >
                      {job.status}
                    </Text>
                  </View>

                  <View style={styles.jobDetails}>
                    {job.categoryName && (
                      <Text style={styles.jobCategory}>{job.categoryName}</Text>
                    )}
                    <Text style={styles.jobAmount}>${job.bidAmount.toFixed(0)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },

  title: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: "800",
  },

  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },

  loadingText: {
    color: COLORS.textMuted,
    marginTop: 12,
    fontSize: 14,
  },

  errorText: {
    color: "#fca5a5",
    marginTop: 12,
    textAlign: "center",
    fontSize: 14,
  },

  retryBtn: {
    marginTop: 16,
    backgroundColor: COLORS.accent,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },

  retryText: {
    color: COLORS.bg,
    fontWeight: "700",
  },

  scrollContent: {
    padding: 16,
  },

  section: {
    marginBottom: 24,
  },

  sectionTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },

  // Metrics Grid

  metricsGridRows: {
    flexDirection: "column",
    gap: 12,
  },

  metricsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 0,
  },

  metricCard: {
    width: cardWidth,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  metricHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },

  metricLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
    flex: 1,
  },

  metricValue: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: "800",
  },

  // Bid Status
  bidStatusContainer: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  bidStatusRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 16,
  },

  bidStatusItem: {
    alignItems: "center",
    flex: 1,
  },

  bidStatusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginBottom: 8,
  },

  bidStatusLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },

  bidStatusValue: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "800",
  },

  bidChart: {
    marginTop: 12,
  },

  chartBar: {
    height: 20,
    borderRadius: 6,
    overflow: "hidden",
    flexDirection: "row",
    marginBottom: 8,
  },

  chartSegment: {
    flex: 1,
  },

  chartLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
  },

  // Earnings Chart
  earningsChart: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },

  monthsContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "flex-end",
    height: 180,
  },

  monthBar: {
    alignItems: "center",
    flex: 1,
  },

  barContainer: {
    height: 120,
    justifyContent: "flex-end",
    alignItems: "center",
    marginBottom: 8,
  },

  bar: {
    width: 20,
    backgroundColor: COLORS.accent,
    borderRadius: 4,
  },

  monthLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },

  monthValue: {
    color: COLORS.text,
    fontSize: 10,
    fontWeight: "700",
  },

  noDataText: {
    color: COLORS.textMuted,
    textAlign: "center",
    fontSize: 13,
    padding: 16,
  },

  // Category List
  categoryList: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 12,
  },

  categoryItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  categoryInfo: {
    flex: 1,
    marginRight: 12,
  },

  categoryName: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },

  categoryBar: {
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
  },

  categoryBarFill: {
    height: 6,
    backgroundColor: COLORS.accent,
    borderRadius: 3,
  },

  categoryCount: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: "700",
    minWidth: 30,
    textAlign: "right",
  },

  // Recent Jobs
  recentJobsList: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: "hidden",
  },

  recentJobCard: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },

  lastRecentJob: {
    borderBottomWidth: 0,
  },

  jobHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },

  jobTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },

  jobStatus: {
    fontSize: 11,
    fontWeight: "700",
    marginLeft: 8,
  },

  jobDetails: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },

  jobCategory: {
    color: COLORS.accent,
    fontSize: 11,
    fontWeight: "600",
  },

  jobAmount: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
  },
});
