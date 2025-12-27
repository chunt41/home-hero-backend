import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";

const parseMoney = (v: string) => {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

export default function CounterBidScreen() {
  const { id, bidId } = useLocalSearchParams<{ id: string; bidId: string }>();
  const jobId = useMemo(() => Number(id), [id]);
  const bidIdNum = useMemo(() => Number(bidId), [bidId]);

  const [mode, setMode] = useState<"exact" | "range">("exact");
  const [exactAmount, setExactAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [message, setMessage] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);

    if (!Number.isFinite(jobId) || !Number.isFinite(bidIdNum)) {
      setError("Invalid job or bid id.");
      return;
    }

    setLoading(true);
    try {
      if (mode === "exact") {
        const amt = parseMoney(exactAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          setError("Enter a valid amount greater than 0.");
          return;
        }

        await api.post(`/bids/${bidIdNum}/counter`, {
          amount: amt,
          message: message.trim(),
        });
      } else {
        const mn = parseMoney(minAmount);
        const mx = parseMoney(maxAmount);

        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn <= 0 || mx <= 0) {
          setError("Enter valid min and max amounts.");
          return;
        }
        if (mn >= mx) {
          setError("Minimum must be less than maximum.");
          return;
        }

        await api.post(`/bids/${bidIdNum}/counter`, {
          minAmount: mn,
          maxAmount: mx,
          message: message.trim(),
        });
      }

      router.back();
    } catch (e: any) {
      setError(e?.message ?? "Failed to submit counter.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Counter Offer</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.label}>Type</Text>
        <View style={styles.toggleRow}>
          <Pressable
            style={[styles.toggleBtn, mode === "exact" && styles.toggleActive]}
            onPress={() => setMode("exact")}
          >
            <Text style={[styles.toggleText, mode === "exact" && styles.toggleTextActive]}>Exact</Text>
          </Pressable>
          <Pressable
            style={[styles.toggleBtn, mode === "range" && styles.toggleActive]}
            onPress={() => setMode("range")}
          >
            <Text style={[styles.toggleText, mode === "range" && styles.toggleTextActive]}>Range</Text>
          </Pressable>
        </View>

        {mode === "exact" ? (
          <TextInput
            value={exactAmount}
            onChangeText={setExactAmount}
            placeholder="e.g. 350"
            placeholderTextColor="#94a3b8"
            keyboardType="numeric"
            style={styles.input}
          />
        ) : (
          <View style={styles.rangeRow}>
            <TextInput
              value={minAmount}
              onChangeText={setMinAmount}
              placeholder="Min"
              placeholderTextColor="#94a3b8"
              keyboardType="numeric"
              style={[styles.input, styles.rangeInput]}
            />
            <TextInput
              value={maxAmount}
              onChangeText={setMaxAmount}
              placeholder="Max"
              placeholderTextColor="#94a3b8"
              keyboardType="numeric"
              style={[styles.input, styles.rangeInput]}
            />
          </View>
        )}

        <Text style={styles.label}>Note (optional)</Text>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Explain why / what’s included…"
          placeholderTextColor="#94a3b8"
          style={[styles.input, styles.textArea]}
          multiline
        />

        <Pressable style={[styles.primaryBtn, loading && styles.btnDisabled]} onPress={onSubmit} disabled={loading}>
          {loading ? <ActivityIndicator /> : <Text style={styles.primaryText}>Submit Counter</Text>}
        </Pressable>
      </View>
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

  content: { padding: 16 },
  label: { color: "#cbd5e1", fontWeight: "800", marginTop: 14, marginBottom: 8 },

  input: {
    backgroundColor: "#0f172a",
    color: "#ffffff",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
  },
  textArea: { minHeight: 100, textAlignVertical: "top" },

  toggleRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  toggleBtn: { flex: 1, backgroundColor: "#1e293b", padding: 12, borderRadius: 10, alignItems: "center" },
  toggleActive: { backgroundColor: "#38bdf8" },
  toggleText: { fontWeight: "900", color: "#e2e8f0" },
  toggleTextActive: { color: "#020617" },

  rangeRow: { flexDirection: "row", gap: 10 },
  rangeInput: { flex: 1 },

  primaryBtn: { marginTop: 18, backgroundColor: "#38bdf8", padding: 14, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#020617", fontWeight: "900" },
  btnDisabled: { opacity: 0.6 },

  error: { color: "#fca5a5", marginBottom: 10 },
});
