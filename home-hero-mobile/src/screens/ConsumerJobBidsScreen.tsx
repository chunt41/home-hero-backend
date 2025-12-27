import React, { useCallback, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useConsumerJobBids, BidForConsumer } from "../hooks/useConsumerJobBids";

export default function ConsumerJobBidsScreen() {
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const [activeFilter, setActiveFilter] = useState<"ALL" | "PENDING" | "ACCEPTED" | "DECLINED">("ALL");

  const jobIdNum = jobId ? Number(jobId) : 0;
  const { bids, loading, error, stats, fetchBids, acceptBid, rejectBid } =
    useConsumerJobBids(jobIdNum);

  useFocusEffect(
    useCallback(() => {
      if (jobIdNum) {
        fetchBids();
      }
    }, [jobIdNum, fetchBids])
  );

  const filteredBids = bids.filter((bid) => {
    if (activeFilter === "ALL") return true;
    return bid.status === activeFilter;
  });

  const handleAcceptBid = (bid: BidForConsumer) => {
    Alert.alert(
      "Accept Bid",
      `Accept $${bid.amount} from ${bid.provider.name}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Accept",
          onPress: async () => {
            try {
              await acceptBid(bid.id);
              Alert.alert("Success", "Bid accepted!");
            } catch (err: any) {
              Alert.alert("Error", err);
            }
          },
        },
      ]
    );
  };

  const handleRejectBid = (bid: BidForConsumer) => {
    Alert.alert(
      "Reject Bid",
      `Reject $${bid.amount} from ${bid.provider.name}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reject",
          style: "destructive",
          onPress: async () => {
            try {
              await rejectBid(bid.id);
              Alert.alert("Success", "Bid rejected");
            } catch (err: any) {
              Alert.alert("Error", err);
            }
          },
        },
      ]
    );
  };

  const renderBidCard = ({ item }: { item: BidForConsumer }) => {
    const statusColor =
      item.status === "ACCEPTED"
        ? "#10b981"
        : item.status === "DECLINED"
        ? "#ef4444"
        : "#f59e0b";

    const statusIcon =
      item.status === "ACCEPTED"
        ? "check-circle"
        : item.status === "DECLINED"
        ? "close-circle"
        : "clock";

    return (
      <View style={styles.bidCard}>
        <View style={styles.bidHeader}>
          <View style={styles.providerInfo}>
            <View
              style={[
                styles.avatar,
                { backgroundColor: `${statusColor}20` },
              ]}
            >
              <MaterialCommunityIcons
                name="account"
                size={24}
                color={statusColor}
              />
            </View>
            <View style={styles.providerDetails}>
              <Text style={styles.providerName}>{item.provider.name}</Text>
              {item.provider.location && (
                <Text style={styles.location}>📍 {item.provider.location}</Text>
              )}
              {item.provider.rating !== null && (
                <Text style={styles.rating}>
                  ⭐ {item.provider.rating.toFixed(1)} ({item.provider.reviewCount} reviews)
                </Text>
              )}
            </View>
          </View>

          <View style={styles.amountBadge}>
            <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
            <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
              <MaterialCommunityIcons
                name={statusIcon as any}
                size={14}
                color="#fff"
              />
              <Text style={styles.statusText}>{item.status}</Text>
            </View>
          </View>
        </View>

        {item.message && (
          <View style={styles.messageSection}>
            <Text style={styles.messageLabel}>Bid Message</Text>
            <Text style={styles.message} numberOfLines={3}>
              {item.message}
            </Text>
          </View>
        )}

        {item.counter && (
          <View style={styles.counterSection}>
            <Text style={styles.counterTitle}>Counter Offer</Text>
            <View style={styles.counterContent}>
              <View>
                <Text style={styles.counterLabel}>Proposed Amount</Text>
                <Text style={styles.counterAmount}>
                  ${item.counter.amount.toFixed(2)}
                </Text>
              </View>
              <View style={styles.counterStatus}>
                <MaterialCommunityIcons
                  name={
                    item.counter.status === "ACCEPTED"
                      ? "check-circle"
                      : item.counter.status === "DECLINED"
                      ? "close-circle"
                      : "clock"
                  }
                  size={20}
                  color={
                    item.counter.status === "ACCEPTED"
                      ? "#10b981"
                      : item.counter.status === "DECLINED"
                      ? "#ef4444"
                      : "#f59e0b"
                  }
                />
                <Text
                  style={[
                    styles.counterStatusText,
                    {
                      color:
                        item.counter.status === "ACCEPTED"
                          ? "#10b981"
                          : item.counter.status === "DECLINED"
                          ? "#ef4444"
                          : "#f59e0b",
                    },
                  ]}
                >
                  {item.counter.status}
                </Text>
              </View>
            </View>
            {item.counter.message && (
              <Text style={styles.counterMessage}>{item.counter.message}</Text>
            )}
          </View>
        )}

        {item.status === "PENDING" && (
          <View style={styles.actionButtons}>
            <Pressable
              style={styles.rejectButton}
              onPress={() => handleRejectBid(item)}
            >
              <MaterialCommunityIcons name="close" size={16} color="#fff" />
              <Text style={styles.rejectButtonText}>Reject</Text>
            </Pressable>
            <Pressable
              style={styles.acceptButton}
              onPress={() => handleAcceptBid(item)}
            >
              <MaterialCommunityIcons name="check" size={16} color="#fff" />
              <Text style={styles.acceptButtonText}>Accept</Text>
            </Pressable>
          </View>
        )}

        <Text style={styles.bidTime}>
          Bid placed {new Date(item.createdAt).toLocaleDateString()}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialCommunityIcons name="chevron-left" size={28} color="#38bdf8" />
        </Pressable>
        <Text style={styles.headerTitle}>Bids on Job</Text>
        <View style={{ width: 28 }} />
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchBids}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading bids...</Text>
        </View>
      ) : (
        <>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{stats.total}</Text>
              <Text style={styles.statLabel}>Total</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: "#f59e0b" }]}>
                {stats.pending}
              </Text>
              <Text style={styles.statLabel}>Pending</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: "#10b981" }]}>
                {stats.accepted}
              </Text>
              <Text style={styles.statLabel}>Accepted</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { color: "#ef4444" }]}>
                {stats.declined}
              </Text>
              <Text style={styles.statLabel}>Declined</Text>
            </View>
          </View>

          <View style={styles.filterRow}>
            {(["ALL", "PENDING", "ACCEPTED", "DECLINED"] as const).map((f) => (
              <Pressable
                key={f}
                style={[
                  styles.filterButton,
                  activeFilter === f && styles.filterButtonActive,
                ]}
                onPress={() => setActiveFilter(f)}
              >
                <Text
                  style={[
                    styles.filterButtonText,
                    activeFilter === f && styles.filterButtonTextActive,
                  ]}
                >
                  {f}
                </Text>
              </Pressable>
            ))}
          </View>

          <FlatList
            data={filteredBids}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderBidCard}
            contentContainerStyle={
              filteredBids.length === 0 ? styles.emptyContainer : styles.listContent
            }
            ListEmptyComponent={
              <View style={styles.emptyContent}>
                <MaterialCommunityIcons
                  name="inbox-outline"
                  size={48}
                  color="#64748b"
                />
                <Text style={styles.emptyText}>No bids in this category</Text>
                <Text style={styles.emptySubText}>
                  Check other tabs to see all bids
                </Text>
              </View>
            }
          />
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

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
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

  statsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  stat: {
    flex: 1,
    backgroundColor: "#0f172a",
    borderRadius: 10,
    padding: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  statValue: {
    color: "#38bdf8",
    fontSize: 20,
    fontWeight: "800",
  },
  statLabel: {
    color: "#94a3b8",
    fontSize: 11,
    marginTop: 4,
    fontWeight: "600",
  },

  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  filterButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
  },
  filterButtonActive: {
    backgroundColor: "#38bdf8",
    borderColor: "#38bdf8",
  },
  filterButtonText: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: "600",
  },
  filterButtonTextActive: {
    color: "#020617",
    fontWeight: "700",
  },

  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
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

  bidCard: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
  },

  bidHeader: {
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
    justifyContent: "center",
    alignItems: "center",
  },

  providerDetails: {
    flex: 1,
  },

  providerName: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },

  location: {
    color: "#cbd5e1",
    fontSize: 12,
    marginTop: 2,
  },

  rating: {
    color: "#94a3b8",
    fontSize: 11,
    marginTop: 2,
  },

  amountBadge: {
    alignItems: "flex-end",
    gap: 6,
  },

  amount: {
    color: "#38bdf8",
    fontSize: 16,
    fontWeight: "800",
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },

  statusText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },

  messageSection: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },

  messageLabel: {
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },

  message: {
    color: "#cbd5e1",
    fontSize: 13,
  },

  counterSection: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },

  counterTitle: {
    color: "#f59e0b",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 8,
  },

  counterContent: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },

  counterLabel: {
    color: "#94a3b8",
    fontSize: 11,
    marginBottom: 2,
  },

  counterAmount: {
    color: "#f59e0b",
    fontSize: 16,
    fontWeight: "800",
  },

  counterStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },

  counterStatusText: {
    fontSize: 12,
    fontWeight: "700",
  },

  counterMessage: {
    color: "#cbd5e1",
    fontSize: 12,
  },

  actionButtons: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },

  rejectButton: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#ef4444",
    borderRadius: 10,
    paddingVertical: 10,
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },

  rejectButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },

  acceptButton: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#10b981",
    borderRadius: 10,
    paddingVertical: 10,
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },

  acceptButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 13,
  },

  bidTime: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 10,
  },
});
