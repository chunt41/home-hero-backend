import React from "react";
import { View, Text, ActivityIndicator, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAdminNotifications, useAdminLogs } from "../../src/hooks/useAdminNotifications";

export default function AdminNotificationsScreen() {
  const { notifications, loading: loadingN, error: errorN } = useAdminNotifications();
  const { logs, loading: loadingL, error: errorL } = useAdminLogs();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617" }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.title}>Admin Notifications</Text>
        {loadingN ? (
          <ActivityIndicator size="large" color="#38bdf8" />
        ) : errorN ? (
          <Text style={styles.error}>{errorN}</Text>
        ) : notifications.length === 0 ? (
          <Text style={styles.muted}>No notifications.</Text>
        ) : (
          notifications.map((n) => (
            <View key={n.id} style={styles.card}>
              <Text style={styles.text}>{n.content}</Text>
              <Text style={styles.meta}>{new Date(n.createdAt).toLocaleString()}</Text>
            </View>
          ))
        )}
        <Text style={styles.title}>Admin Logs</Text>
        {loadingL ? (
          <ActivityIndicator size="large" color="#38bdf8" />
        ) : errorL ? (
          <Text style={styles.error}>{errorL}</Text>
        ) : logs.length === 0 ? (
          <Text style={styles.muted}>No logs.</Text>
        ) : (
          logs.map((l) => (
            <View key={l.id} style={styles.card}>
              <Text style={styles.text}>{l.type}{l.notes ? `: ${l.notes}` : ""}</Text>
              {l.admin && <Text style={styles.meta}>Admin: {l.admin.name} ({l.admin.email})</Text>}
              {l.report && <Text style={styles.meta}>Report: {l.report.reason} ({l.report.status})</Text>}
              <Text style={styles.meta}>{new Date(l.createdAt).toLocaleString()}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 18, marginTop: 18 },
  card: { backgroundColor: "#0f172a", borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: "#1e293b" },
  text: { color: "#f1f5f9", fontSize: 15 },
  meta: { color: "#94a3b8", fontSize: 12, marginTop: 2 },
  error: { color: "#f59e0b", fontWeight: "700", marginBottom: 8 },
  muted: { color: "#94a3b8", marginTop: 12 },
});
