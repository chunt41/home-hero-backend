import React, { useCallback, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useCombinedEarnings } from "../hooks/useCombinedEarnings";
import { format } from "date-fns";

type TabType = "overview" | "subscriptions" | "ads" | "payouts";

export default function AdminEarningsScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const { earnings, loading, error, refetch } = useCombinedEarnings();

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const renderStatCard = (
    icon: string,
    label: string,
    value: string | number,
    color: string,
    subtext?: string
  ) => (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: `${color}20` }]}>
        <MaterialCommunityIcons name={icon as any} size={24} color={color} />
      </View>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {subtext && <Text style={styles.statSubtext}>{subtext}</Text>}
    </View>
  );

  const renderOverview = () => {
    if (!earnings) return null;

    return (
      <ScrollView
        contentContainerStyle={styles.tabContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Main stats */}
        <View style={styles.statsGrid}>
          {renderStatCard(
            "currency-usd",
            "Total Earnings",
            `$${earnings.totalEarnings.toFixed(2)}`,
            "#10b981"
          )}
          {renderStatCard(
            "trending-up",
            "Pending Payout",
            `$${earnings.pendingPayout.toFixed(2)}`,
            "#f59e0b"
          )}
        </View>

        {/* Breakdown */}
        <View style={styles.statsGrid}>
          {renderStatCard(
            "credit-card",
            "Subscriptions",
            `$${earnings.totalSubscriptionRevenue.toFixed(2)}`,
            "#3b82f6",
            `${earnings.paymentHistory.length} payments`
          )}
          {renderStatCard(
            "google-analytics",
            "Ad Revenue",
            `$${earnings.totalAdRevenue.toFixed(2)}`,
            "#8b5cf6",
            `${earnings.adRevenueHistory.length} ads served`
          )}
        </View>

        {/* Monthly breakdown chart */}
        {earnings.monthlyBreakdown.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Monthly Breakdown</Text>
            {earnings.monthlyBreakdown.map((month, idx) => (
              <View key={idx} style={styles.monthRow}>
                <Text style={styles.monthLabel}>{month.month}</Text>
                <View style={styles.monthBarContainer}>
                  <View
                    style={[
                      styles.monthBar,
                      {
                        width: `${Math.min(
                          (month.total / Math.max(...earnings.monthlyBreakdown.map(m => m.total), 100)) * 100,
                          100
                        )}%`,
                      },
                    ]}
                  >
                    <Text style={styles.monthBarText}>
                      ${month.total.toFixed(0)}
                    </Text>
                  </View>
                </View>
                <View style={styles.monthDetails}>
                  <Text style={styles.monthDetail}>
                    <Text style={{ color: "#3b82f6" }}>S</Text>: ${month.subscriptions.toFixed(0)}
                  </Text>
                  <Text style={styles.monthDetail}>
                    <Text style={{ color: "#8b5cf6" }}>A</Text>: ${month.ads.toFixed(0)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Request payout button */}
        {earnings.pendingPayout > 0 && (
          <Pressable style={styles.payoutButton} onPress={() => {
            Alert.alert(
              "Payout Request",
              `Request payout of $${earnings.pendingPayout.toFixed(2)}?`,
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Request Payout",
                  onPress: () => {
                    Alert.alert(
                      "Success",
                      "Payout request submitted. We'll review and process it within 5-7 business days."
                    );
                  },
                },
              ]
            );
          }}>
            <MaterialCommunityIcons name="bank-transfer" size={20} color="#020617" />
            <Text style={styles.payoutButtonText}>
              Request Payout: ${earnings.pendingPayout.toFixed(2)}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    );
  };

  const renderSubscriptions = () => {
    if (!earnings || earnings.paymentHistory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons
            name="credit-card-off"
            size={48}
            color="#64748b"
          />
          <Text style={styles.emptyText}>No subscription payments yet</Text>
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.tabContent}>
        {earnings.paymentHistory.map((payment) => (
          <View key={payment.id} style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.historyTier}>{payment.tier} Plan</Text>
                <Text style={styles.historyDate}>
                  {format(new Date(payment.createdAt), "MMM dd, yyyy")}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.historyAmount}>
                  ${(payment.amount / 100).toFixed(2)}
                </Text>
                <Text
                  style={[
                    styles.historyStatus,
                    payment.status === "SUCCEEDED"
                      ? { color: "#86efac" }
                      : { color: "#fca5a5" },
                  ]}
                >
                  {payment.status}
                </Text>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderAds = () => {
    if (!earnings || earnings.adRevenueHistory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons name="google-analytics" size={48} color="#64748b" />
          <Text style={styles.emptyText}>No ad revenue yet</Text>
          <Text style={styles.emptySubText}>
            Ad revenue appears when users view ads on your profile
          </Text>
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.tabContent}>
        {earnings.adRevenueHistory.map((ad) => (
          <View key={ad.id} style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.historyTier}>
                  {ad.adFormat.charAt(0).toUpperCase() + ad.adFormat.slice(1)} Ad
                </Text>
                <Text style={styles.historyDate}>
                  {format(new Date(ad.date), "MMM dd, yyyy")}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.historyAmount}>
                  ${Number(ad.revenue).toFixed(2)}
                </Text>
                <Text style={styles.historyMeta}>
                  {ad.impressions} impressions • {ad.clicks} clicks
                </Text>
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
    );
  };

  const renderPayouts = () => {
    if (!earnings || earnings.payoutHistory.length === 0) {
      return (
        <View style={styles.emptyState}>
          <MaterialCommunityIcons
            name="cash-off"
            size={48}
            color="#64748b"
          />
          <Text style={styles.emptyText}>No payouts yet</Text>
          <Text style={styles.emptySubText}>
            Request a payout from the Overview tab
          </Text>
        </View>
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.tabContent}>
        {earnings.payoutHistory.map((payout) => (
          <View key={payout.id} style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.historyTier}>
                  {payout.type === "subscription" ? "Subscription" : "Ad Revenue"} Payout
                </Text>
                <Text style={styles.historyDate}>
                  {format(new Date(payout.createdAt), "MMM dd, yyyy")}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.historyAmount}>
                  ${Number(payout.amount).toFixed(2)}
                </Text>
                <Text
                  style={[
                    styles.historyStatus,
                    payout.status === "completed"
                      ? { color: "#86efac" }
                      : payout.status === "pending"
                      ? { color: "#fbbf24" }
                      : { color: "#fca5a5" },
                  ]}
                >
                  {payout.status.charAt(0).toUpperCase() + payout.status.slice(1)}
                </Text>
              </View>
            </View>
            {payout.paidAt && (
              <Text style={styles.historyMeta}>
                Paid: {format(new Date(payout.paidAt), "MMM dd, yyyy")}
              </Text>
            )}
          </View>
        ))}
      </ScrollView>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.screenTitle}>Admin Earnings Dashboard</Text>

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
        <>
          {/* Tab Navigation */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabNav}
          >
            {(["overview", "subscriptions", "ads", "payouts"] as TabType[]).map(
              (tab) => (
                <Pressable
                  key={tab}
                  onPress={() => setActiveTab(tab)}
                  style={[
                    styles.tab,
                    activeTab === tab && styles.tabActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.tabLabel,
                      activeTab === tab && styles.tabLabelActive,
                    ]}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </Text>
                </Pressable>
              )
            )}
          </ScrollView>

          {/* Tab Content */}
          {activeTab === "overview" && renderOverview()}
          {activeTab === "subscriptions" && renderSubscriptions()}
          {activeTab === "ads" && renderAds()}
          {activeTab === "payouts" && renderPayouts()}
        </>
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
    fontWeight: "900",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },

  errorBox: {
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: "#7f1d1d",
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

  tabNav: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },

  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#0f172a",
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  tabActive: {
    backgroundColor: "#38bdf8",
    borderColor: "#38bdf8",
  },

  tabLabel: {
    color: "#94a3b8",
    fontWeight: "700",
    fontSize: 13,
  },

  tabLabelActive: {
    color: "#020617",
  },

  tabContent: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingBottom: 32,
  },

  statsGrid: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },

  statCard: {
    flex: 1,
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1e293b",
    alignItems: "center",
  },

  statIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },

  statLabel: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 6,
  },

  statValue: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "900",
    textAlign: "center",
  },

  statSubtext: {
    color: "#64748b",
    fontSize: 10,
    marginTop: 4,
  },

  section: {
    marginBottom: 20,
  },

  sectionTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 12,
  },

  monthRow: {
    marginBottom: 12,
  },

  monthLabel: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },

  monthBarContainer: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    overflow: "hidden",
    marginBottom: 6,
    minHeight: 28,
  },

  monthBar: {
    backgroundColor: "#38bdf8",
    justifyContent: "center",
    alignItems: "center",
    minHeight: 28,
  },

  monthBarText: {
    color: "#020617",
    fontSize: 11,
    fontWeight: "900",
  },

  monthDetails: {
    flexDirection: "row",
    gap: 12,
    fontSize: 10,
  },

  monthDetail: {
    color: "#94a3b8",
    fontSize: 10,
  },

  payoutButton: {
    backgroundColor: "#10b981",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 12,
  },

  payoutButtonText: {
    color: "#020617",
    fontWeight: "900",
    fontSize: 14,
    flex: 1,
  },

  historyCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  historyHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },

  historyTier: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },

  historyDate: {
    color: "#94a3b8",
    fontSize: 12,
    marginTop: 4,
  },

  historyAmount: {
    color: "#38bdf8",
    fontSize: 16,
    fontWeight: "900",
  },

  historyStatus: {
    fontSize: 11,
    fontWeight: "700",
    marginTop: 4,
  },

  historyMeta: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 8,
  },

  emptyState: {
    flex: 1,
    justifyContent: "center",
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
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
    paddingHorizontal: 16,
  },
});
