import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Link } from "expo-router";
import { useState } from "react";
import { useAuth } from "../../src/context/AuthContext";

export default function LoginScreen() {
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      // No router.push needed — your auth guard will redirect automatically.
    } catch (e: any) {
      setError(e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome Back</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        placeholderTextColor="#94a3b8"
        style={styles.input}
      />

      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        placeholderTextColor="#94a3b8"
        style={styles.input}
      />

      <Pressable style={styles.button} onPress={onLogin} disabled={loading}>
        {loading ? <ActivityIndicator /> : <Text style={styles.buttonText}>Login</Text>}
      </Pressable>

      <Link href="/signup" style={styles.link}>
        Don’t have an account? Sign up
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#020617", justifyContent: "center", padding: 24 },
  title: { fontSize: 32, fontWeight: "bold", color: "#ffffff", marginBottom: 24, textAlign: "center" },
  error: { color: "#f87171", textAlign: "center", marginBottom: 12 },
  input: { backgroundColor: "#0f172a", color: "#ffffff", padding: 16, borderRadius: 8, marginBottom: 16 },
  button: { backgroundColor: "#38bdf8", padding: 16, borderRadius: 8, marginTop: 8, alignItems: "center" },
  buttonText: { color: "#020617", fontSize: 18, fontWeight: "bold" },
  link: { color: "#38bdf8", marginTop: 24, textAlign: "center" },
});
