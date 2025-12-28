

import React, { useState } from "react";
import { View, Text, TextInput, FlatList, ActivityIndicator, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAdminUsers } from "../../src/hooks/useAdminUsers";
import { impersonateUser } from "../../src/hooks/useImpersonateUser";
import { saveAuthToken } from "../../src/lib/apiClient";

export default function UserManagementScreen() {
  const [search, setSearch] = useState("");
  const { users, loading, error } = useAdminUsers(search);

  const handleImpersonate = async (userId: number) => {
    try {
      const token = await impersonateUser(userId);
      await saveAuthToken(token);
      Alert.alert("Impersonation Success", "You are now impersonating this user. Please reload the app to see their view.");
    } catch (err: any) {
      Alert.alert("Impersonation Failed", err?.message || "Could not impersonate user");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#020617", padding: 16 }} edges={["top"]}>
      <Text style={styles.title}>User Management</Text>
      <TextInput
        style={styles.input}
        placeholder="Search by name or email..."
        placeholderTextColor="#64748b"
        value={search}
        onChangeText={setSearch}
      />
      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color="#38bdf8" /></View>
      ) : error ? (
        <View style={styles.center}><Text style={styles.error}>Failed to load users</Text><Text style={styles.muted}>{error}</Text></View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.email}>{item.email}</Text>
              <Text style={styles.meta}>Role: {item.role} | Created: {new Date(item.createdAt).toLocaleDateString()}</Text>
              <Text style={[styles.meta, item.isSuspended && styles.suspended]}>{item.isSuspended ? "Suspended" : "Active"}</Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                <TouchableOpacity
                  style={styles.impersonateBtn}
                  onPress={() => handleImpersonate(item.id)}
                >
                  <Text style={styles.impersonateText}>Impersonate</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={<Text style={styles.muted}>No users found.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { color: "#f1f5f9", fontSize: 22, fontWeight: "800", marginBottom: 18 },
  input: { backgroundColor: "#0f172a", color: "#f1f5f9", borderRadius: 8, padding: 10, marginBottom: 16, borderWidth: 1, borderColor: "#1e293b" },
  center: { alignItems: "center", justifyContent: "center", marginTop: 32 },
  error: { color: "#f59e0b", fontWeight: "700", marginBottom: 8 },
  muted: { color: "#94a3b8", marginTop: 12 },
  card: { backgroundColor: "#0f172a", borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: "#1e293b" },
  name: { color: "#38bdf8", fontWeight: "700", fontSize: 16 },
  email: { color: "#f1f5f9", fontSize: 13 },
  meta: { color: "#94a3b8", fontSize: 12 },
  suspended: { color: "#f59e0b" },
  impersonateBtn: { marginTop: 8, backgroundColor: "#38bdf8", borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12, alignSelf: "flex-start" },
  impersonateText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});
