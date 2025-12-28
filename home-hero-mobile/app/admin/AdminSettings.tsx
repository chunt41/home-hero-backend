
import React from "react";
import { View, Text, StyleSheet, Switch, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAuth } from "../../src/context/AuthContext";

export default function AdminSettingsScreen() {
  const { user, logout } = useAuth();
  // Placeholder state for preferences
  const [notificationsEnabled, setNotificationsEnabled] = React.useState(true);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Text style={styles.title}>Admin Settings</Text>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile</Text>
        <Text style={styles.label}>Name: {user?.name ?? "Admin"}</Text>
        <Text style={styles.label}>Email: {user?.email ?? ""}</Text>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Enable Notifications</Text>
          <Switch
            value={notificationsEnabled}
            onValueChange={setNotificationsEnabled}
            thumbColor={notificationsEnabled ? "#38bdf8" : "#64748b"}
            trackColor={{ true: "#bae6fd", false: "#334155" }}
          />
        </View>
      </View>

      <TouchableOpacity
        style={styles.logoutBtn}
        onPress={async () => {
          await logout();
          router.replace("/login" as any);
        }}
      >
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617", padding: 16 },
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 18 },
  section: { marginBottom: 24 },
  sectionTitle: { color: "#38bdf8", fontWeight: "700", fontSize: 16, marginBottom: 8 },
  label: { color: "#f1f5f9", fontSize: 14, marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  logoutBtn: { marginTop: 8, backgroundColor: "#0f172a", borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: "#1e293b" },
  logoutText: { color: "#38bdf8", fontWeight: "800" },
});
