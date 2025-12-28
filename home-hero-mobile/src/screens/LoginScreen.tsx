import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Alert, StyleSheet } from "react-native";
import { api } from "../lib/apiClient";
import { getErrorMessage } from "../lib/getErrorMessage";

type LoginResponse = {
  token: string;
  user: {
    id: number;
    role: "CONSUMER" | "PROVIDER" | "ADMIN";
    email: string;
  };
};

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onLogin() {
    try {
      setLoading(true);

      const data = await api.post<LoginResponse>("/auth/login", { email, password });

      Alert.alert("Logged in!", `Role: ${data.user.role}\nToken starts with: ${data.token.slice(0, 16)}...`);
    } catch (e: any) {
      Alert.alert("Login failed", getErrorMessage(e, "Unknown error"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Home Hero</Text>
      <Text style={styles.subtitle}>Log in</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="you@example.com"
        style={styles.input}
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="••••••••"
        style={styles.input}
      />

      <Pressable style={[styles.button, loading && styles.buttonDisabled]} onPress={onLogin} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Logging in..." : "Log In"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 32, fontWeight: "800", marginBottom: 6 },
  subtitle: { fontSize: 18, marginBottom: 18 },
  label: { fontSize: 14, marginTop: 10, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 12, fontSize: 16 },
  button: { marginTop: 18, backgroundColor: "black", padding: 14, borderRadius: 12, alignItems: "center" },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "700" },
});
