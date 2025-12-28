import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api } from "../src/lib/apiClient";
import { getErrorMessage } from "../src/lib/getErrorMessage";

type BlockItem = {
  id: number;
  blockedUser: { id: number; name: string | null; email: string; role: string };
  createdAt: string;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function BlockedUsersScreen() {
  const [items, setItems] = useState<BlockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBlocks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<BlockItem[]>("/me/blocks");
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(getErrorMessage(e, "Failed to load blocked users."));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const onUnblock = useCallback(
    (userId: number) => {
      Alert.alert("Unblock user?", "They will be able to contact you again.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unblock",
          style: "destructive",
          onPress: async () => {
            try {
              await api.delete(`/users/${userId}/block`);
              await fetchBlocks();
            } catch (e: any) {
              Alert.alert("Error", getErrorMessage(e, "Failed to unblock."));
            }
          },
        },
      ]);
    },
    [fetchBlocks]
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Blocked Users</Text>
        <Pressable onPress={fetchBlocks} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>↻</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchBlocks}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No blocked users.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.name} numberOfLines={1}>
                {item.blockedUser.name ?? "User"}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {item.blockedUser.email} • {item.blockedUser.role}
              </Text>
              <Text style={styles.meta}>Blocked: {formatDate(item.createdAt)}</Text>

              <Pressable
                style={[styles.dangerBtn, { marginTop: 10 }]}
                onPress={() => onUnblock(item.blockedUser.id)}
              >
                <Text style={styles.dangerText}>Unblock</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617" },

  header: {
    paddingBottom: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  backBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  backText: { color: "#38bdf8", fontWeight: "800" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "900" },
  headerBtn: {
    width: 44,
    height: 36,
    borderRadius: 12,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#111827",
  },
  headerBtnText: { color: "#38bdf8", fontWeight: "900", fontSize: 16 },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  muted: { color: "#cbd5e1", marginTop: 10 },
  error: { color: "#fca5a5", marginBottom: 12 },

  retryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "900" },

  list: { padding: 16, paddingBottom: 26 },
  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  name: { color: "#fff", fontSize: 16, fontWeight: "900" },
  meta: { color: "#94a3b8", marginTop: 6, fontSize: 12 },

  dangerBtn: {
    backgroundColor: "#ef4444",
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  dangerText: { color: "#0b1220", fontWeight: "900" },
});
