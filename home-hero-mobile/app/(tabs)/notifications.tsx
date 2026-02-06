import React, { useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { useNotifications, NotificationItem } from "../../src/hooks/useNotifications";
import { MaterialCommunityIcons } from "@expo/vector-icons";

export default function NotificationsScreen() {
  const {
    items,
    loading,
    refreshing,
    error,
    markRead,
    markAllRead,
    refetch,
  } = useNotifications(30000);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );

  const unreadCount = items.filter((n) => !n.isRead).length;

  const getNotificationIcon = (type: string) => {
    switch (type) {
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
      default:
        return "bell";
    }
  };

  const getNotificationColor = (type: string) => {
    switch (type) {
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
      default:
        return "#38bdf8";
    }
  };

  const renderItem = ({ item }: { item: NotificationItem }) => {
    const backgroundColor = item.isRead ? "#0f172a" : "#1e293b";
    const borderColor = item.isRead ? "#1e293b" : "#38bdf8";

    return (
      <Pressable
        onPress={() => {
          if (!item.isRead) markRead(item.id);
        }}
        style={[
          styles.row,
          { backgroundColor, borderColor },
        ]}
      >
        <View style={styles.iconContainer}>
          <MaterialCommunityIcons
            name={getNotificationIcon(item.type) as any}
            size={20}
            color={getNotificationColor(item.type)}
          />
        </View>

        <View style={styles.content}>
          <Text
            style={[styles.title, !item.isRead && styles.unreadTitle]}
            numberOfLines={2}
          >
            {item.title ?? item.type}
          </Text>

          {item.body && (
            <Text style={styles.body} numberOfLines={2}>
              {item.body}
            </Text>
          )}

          <Text style={styles.date}>
            {new Date(item.createdAt).toLocaleString()}
          </Text>
        </View>

        {!item.isRead && <View style={styles.unreadBadge} />}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Notifications</Text>
        {unreadCount > 0 && (
          <Pressable onPress={markAllRead} style={styles.btn}>
            <Text style={styles.btnText}>Mark all read</Text>
          </Pressable>
        )}
      </View>

      {unreadCount > 0 && (
        <View style={styles.unreadBanner}>
          <MaterialCommunityIcons name="information" size={16} color="#fff" />
          <Text style={styles.unreadBannerText}>
            {unreadCount} unread notification{unreadCount !== 1 ? "s" : ""}
          </Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#38bdf8" />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="alert-circle" size={48} color="#ef4444" />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={refetch} style={[styles.btn, { marginTop: 16 }]}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => String(it.id)}
          renderItem={renderItem}
          refreshing={refreshing}
          onRefresh={refetch}
          contentContainerStyle={items.length ? styles.listContent : styles.center}
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
  container: { flex: 1, backgroundColor: "#020617" },
  
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  h1: {
    fontSize: 22,
    fontWeight: "800",
    color: "#fff",
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#1e293b",
  },
  btnText: {
    color: "#38bdf8",
    fontWeight: "600",
    fontSize: 12,
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

  listContent: { paddingHorizontal: 16, paddingVertical: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: "#1e293b",
  },

  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },

  content: { flex: 1 },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#e2e8f0",
  },
  unreadTitle: { fontWeight: "800", color: "#fff" },
  body: {
    marginTop: 4,
    color: "#cbd5e1",
    fontSize: 12,
  },
  date: {
    marginTop: 6,
    fontSize: 11,
    color: "#64748b",
  },

  unreadBadge: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#38bdf8",
    marginLeft: 12,
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
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

  loadingText: { color: "#cbd5e1", marginTop: 12 },
  errorText: {
    color: "#fca5a5",
    textAlign: "center",
    marginTop: 12,
    fontSize: 14,
  },
});
