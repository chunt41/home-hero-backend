

import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAdminStats } from "../hooks/useAdminStats";
import { router } from "expo-router";
import { useAuth } from "../context/AuthContext";

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


export default function AdminDashboardScreen() {
  const { stats, loading, error, refetch } = useAdminStats();
  const { logout } = useAuth();

  const metrics = [
    { label: "Total Users", value: stats?.totalUsers ?? 0, icon: "account-group", color: COLORS.accent },
    { label: "Providers", value: stats?.providers ?? 0, icon: "account-tie", color: COLORS.success },
    { label: "Consumers", value: stats?.consumers ?? 0, icon: "account", color: COLORS.textMuted },
    { label: "Jobs Completed", value: stats?.jobsCompleted ?? 0, icon: "check-circle", color: COLORS.success },
    { label: "Revenue", value: stats ? `$${stats.revenue.toLocaleString()}` : "$0", icon: "cash", color: COLORS.accent },
    { label: "Flagged Jobs", value: stats?.flaggedJobs ?? 0, icon: "alert", color: COLORS.warning },
    { label: "Pending Verifications", value: stats?.pendingVerifications ?? 0, icon: "account-alert", color: COLORS.warning },
  ];

  const quickLinks = [
    { label: "Review Flagged Jobs", icon: "alert", screen: "/admin/FlaggedJobs" },
    { label: "Provider Verifications", icon: "account-alert", screen: "/admin/AdminProviderVerifications" },
    { label: "Reports / Moderation", icon: "flag", screen: "/admin/AdminReports" },
    { label: "User Management", icon: "account-search", screen: "/admin/UserManagement" },
    { label: "Platform Analytics", icon: "chart-bar", screen: "/admin/AdminAnalytics" },
    { label: "Settings", icon: "cog", screen: "/admin/AdminSettings" },
  ];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Admin Dashboard</Text>
          <TouchableOpacity
            onPress={async () => {
              await logout();
              router.replace("/login" as any);
            }}
            style={styles.logoutBtn}
          >
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={{ alignItems: "center", marginVertical: 32 }}>
            <ActivityIndicator size="large" color={COLORS.accent} />
            <Text style={{ color: COLORS.textMuted, marginTop: 12 }}>Loading metrics...</Text>
          </View>
        ) : error ? (
          <View style={{ alignItems: "center", marginVertical: 32 }}>
            <Text style={{ color: COLORS.warning, fontWeight: "700", marginBottom: 8 }}>Failed to load metrics</Text>
            <Text style={{ color: COLORS.textMuted, marginBottom: 8 }}>{error}</Text>
            <TouchableOpacity onPress={refetch} style={{ padding: 8 }}>
              <Text style={{ color: COLORS.accent, fontWeight: "700" }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.metricsGrid}>
            {metrics.map((m, i) => (
              <View key={i} style={styles.metricCard}>
                <MaterialCommunityIcons name={m.icon as any} size={28} color={m.color} />
                <Text style={styles.metricValue}>{m.value}</Text>
                <Text style={styles.metricLabel}>{m.label}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.sectionTitle}>Quick Links</Text>
        <View style={styles.linksGrid}>
          {quickLinks.map((l, i) => (
            <TouchableOpacity
              key={i}
              style={styles.linkCard}
              onPress={() => router.push(l.screen as any)}
            >
              <MaterialCommunityIcons name={l.icon as any} size={24} color={COLORS.accent} />
              <Text style={styles.linkLabel}>{l.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  scrollContent: { padding: 16 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  title: { color: COLORS.text, fontSize: 24, fontWeight: "800" },
  logoutBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.card },
  logoutText: { color: COLORS.accent, fontWeight: "800" },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 24,
  },
  metricCard: {
    width: "30%",
    minWidth: 110,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    marginBottom: 8,
  },
  metricValue: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: "800",
    marginTop: 8,
  },
  metricLabel: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
    marginTop: 16,
  },
  linksGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  linkCard: {
    width: "45%",
    minWidth: 140,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    marginBottom: 12,
  },
  linkLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 8,
    textAlign: "center",
  },
});
