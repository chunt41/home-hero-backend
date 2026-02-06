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
import { router, useFocusEffect } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useNotifications } from "../hooks/useNotifications";
import { formatDistanceToNow } from "date-fns";

export default function NotificationsScreen() {
  const {
    items,
    loading,
    refreshing,
    error,
    refetch,
    markRead,
    markAllRead,
  } = useNotifications();

  const unreadCount = items.reduce((acc, n) => acc + (n.isRead ? 0 : 1), 0);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const onRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "job.match":
        return "briefcase-search-outline";
      case "NEW_BID":
        return "gavel";
      case "COUNTER_OFFER":
        return "handshake";
      case "BID_ACCEPTED":
        return "check-circle";
      case "BID_REJECTED":
        return "close-circle";
      case "MESSAGE":
        return "message";
      case "JOB_COMPLETED":
        return "star";
      case "JOB_COMPLETION_CONFIRM_REQUIRED":
        return "check-decagram";
      case "JOB_COMPLETION_MARKED":
        return "timer-sand";
      default:
        return "bell";
    }
  };

  const getNotificationColor = (type: string) => {
    switch (type) {
      case "job.match":
        return "#38bdf8";
      case "NEW_BID":
        return "#3b82f6";
      case "COUNTER_OFFER":
        return "#f59e0b";
      case "BID_ACCEPTED":
        return "#10b981";
      case "BID_REJECTED":
        return "#ef4444";
      case "MESSAGE":
        return "#8b5cf6";
      case "JOB_COMPLETED":
        return "#ec4899";
      case "JOB_COMPLETION_CONFIRM_REQUIRED":
        return "#f59e0b";
      case "JOB_COMPLETION_MARKED":
        return "#38bdf8";
      default:
        return "#38bdf8";
    }
  };

  const renderNotification = ({ item }: { item: any }) => {
    const backgroundColor = item.isRead ? "#0f172a" : "#1e293b";
    const borderColor = item.isRead ? "#1e293b" : "#38bdf8";

    return (
      <Pressable
        style={[
          styles.notificationCard,
          { backgroundColor, borderColor },
        ]}
        onPress={() => {
          if (!item.isRead) {
            markRead(item.id);
          }

          if (item.type === "job.match" && typeof item.jobId === "number") {
            router.push(`/job/${item.jobId}`);
          }
        }}
      >
        <View style={styles.iconContainer}>
          <MaterialCommunityIcons
            name={getNotificationIcon(item.type) as any}
            size={24}
            color={getNotificationColor(item.type)}
          />
        </View>

        <View style={styles.content}>
          <Text style={styles.title} numberOfLines={2}>
            {item.title}
          </Text>
          {item.body && (
            <Text style={styles.body} numberOfLines={2}>
              {item.body}
            </Text>
          )}
          <Text style={styles.time}>
            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
          </Text>
        </View>

        {!item.isRead && (
          <View style={styles.unreadBadge} />
        )}
      </Pressable>
    );
  };

  const isEmpty = items.length === 0 && !loading;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.screenTitle}>Notifications</Text>
        {unreadCount > 0 && (
          <Pressable
            style={styles.markAllBtn}
            onPress={markAllRead}
          >
            <Text style={styles.markAllBtnText}>Mark All as Read</Text>
          </Pressable>
        )}
      </View>

      {unreadCount > 0 && (
        <View style={styles.unreadBanner}>
          <MaterialCommunityIcons name="information" size={16} color="#fff" />
          <Text style={styles.unreadBannerText}>
            You have {unreadCount} unread notification{unreadCount !== 1 ? "s" : ""}
          </Text>
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable
            style={styles.retryBtn}
            onPress={refetch}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderNotification}
          refreshing={refreshing}
          onRefresh={onRefresh}
          contentContainerStyle={
            isEmpty ? styles.emptyContainer : styles.listContent
          }
          ListEmptyComponent={
            <View style={styles.emptyContent}>
              <MaterialCommunityIcons
                name="bell-off"
                size={48}
                color="#64748b"
              />
              <Text style={styles.emptyText}>No notifications yet</Text>
              <Text style={styles.emptySubText}>
                We’ll notify you when something happens
              </Text>
            </View>
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

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  screenTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "800",
  },
  markAllBtn: {
    backgroundColor: "#1e293b",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  markAllBtnText: {
    color: "#38bdf8",
    fontSize: 12,
    fontWeight: "600",
  },

  unreadBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e40af",
    marginHorizontal: 16,
    marginVertical: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 8,
  },
  unreadBannerText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
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

  notificationCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f172a",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: "#1e293b",
  },

  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },

  content: {
    flex: 1,
  },
  title: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },
  body: {
    color: "#cbd5e1",
    fontSize: 12,
    marginTop: 4,
  },
  time: {
    color: "#64748b",
    fontSize: 11,
    marginTop: 4,
  },

  unreadBadge: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#38bdf8",
    marginLeft: 12,
  },

  footerLoader: {
    paddingVertical: 16,
    alignItems: "center",
  },
});
