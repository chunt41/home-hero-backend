import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api } from "../src/lib/apiClient";

type MyReport = {
  id: number;
  targetType: "USER" | "JOB" | "MESSAGE" | string;
  targetUserId: number | null;
  targetJobId: number | null;
  targetMessageId: number | null;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED" | string;
  reason: string;
  details: string | null;
  adminNotes: string | null;
  createdAt: string;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function MyReportsScreen() {
  const [items, setItems] = useState<MyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<MyReport[]>("/me/reports");
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load reports.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>My Reports</Text>
        <Pressable onPress={fetchReports} style={styles.headerBtn}>
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
          <Pressable style={styles.retryBtn} onPress={fetchReports}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {items.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>No reports yet</Text>
              <Text style={styles.bodyMuted}>
                When you submit a report, it will show up here.
              </Text>
            </View>
          ) : (
            items.map((r) => (
              <View key={r.id} style={styles.card}>
                <Text style={styles.sectionTitle}>
                  #{r.id} • {r.status}
                </Text>
                <Text style={styles.bodyMuted}>
                  {r.targetType} • Target {r.targetUserId ?? r.targetJobId ?? r.targetMessageId}
                </Text>
                <Text style={[styles.body, { marginTop: 8 }]}>{r.reason}</Text>
                {r.details ? (
                  <Text style={[styles.bodyMuted, { marginTop: 6 }]}>
                    Details: {r.details}
                  </Text>
                ) : null}
                {r.adminNotes ? (
                  <Text style={[styles.bodyMuted, { marginTop: 6 }]}>
                    Admin notes: {r.adminNotes}
                  </Text>
                ) : null}
                <Text style={styles.metaSmall}>{formatDate(r.createdAt)}</Text>
              </View>
            ))
          )}
        </ScrollView>
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

  content: { padding: 16, paddingBottom: 26 },
  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 6, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },
  metaSmall: { color: "#94a3b8", marginTop: 10, fontSize: 12 },
});
