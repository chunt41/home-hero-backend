import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";

const parseMoney = (v: string) => {
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

export default function PlaceBidScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [mode, setMode] = useState<"exact" | "range">("exact");

  const [exactAmount, setExactAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");

  const [message, setMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);

    if (!Number.isFinite(jobId)) {
      setError("Invalid job id.");
      return;
    }

    let amountToSend: number;
    let messageToSend = message.trim();

    if (mode === "exact") {
      const amt = parseMoney(exactAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        setError("Enter a valid amount greater than 0.");
        return;
      }
      amountToSend = amt;
      // keep message as-is (can be blank)
    } else {
      const min = parseMoney(minAmount);
      const max = parseMoney(maxAmount);

      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
        setError("Enter valid min and max amounts.");
        return;
      }
      if (min >= max) {
        setError("Minimum must be less than maximum.");
        return;
      }

      // Backend needs a single numeric amount → we use the MAX as the canonical number.
      amountToSend = max;

      // Consistent, parseable line for Job Details
      const rangeLine = `Estimated range: $${min}-${max}`;
      messageToSend = messageToSend ? `${messageToSend}\n${rangeLine}` : rangeLine;
    }

    setSubmitting(true);
    try {
      await api.post(`/jobs/${jobId}/bids`, {
        amount: amountToSend,
        message: messageToSend, // backend accepts blank string too
      });

      Alert.alert("Bid placed", "Your bid was submitted successfully.");
      router.back();
    } catch (e: any) {
      const msg = e?.message ?? "Failed to place bid.";
      setError(msg);
      if (String(msg).toLowerCase().includes("free tier limit")) {
        Alert.alert("Bid limit reached", msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          Place Bid
        </Text>

        <View style={{ width: 60 }} />
      </View>

      <View style={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.label}>Pricing</Text>

        <View style={styles.toggleRow}>
          <Pressable
            style={[styles.toggleBtn, mode === "exact" && styles.toggleActive]}
            onPress={() => setMode("exact")}
          >
            <Text style={[styles.toggleText, mode === "exact" && styles.toggleTextActive]}>
              Exact
            </Text>
          </Pressable>

          <Pressable
            style={[styles.toggleBtn, mode === "range" && styles.toggleActive]}
            onPress={() => setMode("range")}
          >
            <Text style={[styles.toggleText, mode === "range" && styles.toggleTextActive]}>
              Range
            </Text>
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

        <Text style={styles.label}>Message (optional)</Text>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder="Quick note to the customer…"
          placeholderTextColor="#94a3b8"
          style={[styles.input, styles.textArea]}
          multiline
        />

        <Pressable
          style={[styles.primaryBtn, submitting ? styles.btnDisabled : null]}
          onPress={onSubmit}
          disabled={submitting}
        >
          {submitting ? <ActivityIndicator /> : <Text style={styles.primaryText}>Submit Bid</Text>}
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
  toggleBtn: {
    flex: 1,
    backgroundColor: "#1e293b",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  toggleActive: { backgroundColor: "#38bdf8" },
  toggleText: { fontWeight: "900", color: "#e2e8f0" },
  toggleTextActive: { color: "#020617" },

  rangeRow: { flexDirection: "row", gap: 10 },
  rangeInput: { flex: 1 },

  error: { color: "#fca5a5", marginBottom: 10 },

  primaryBtn: {
    marginTop: 18,
    backgroundColor: "#38bdf8",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  btnDisabled: { opacity: 0.6 },
  primaryText: { color: "#020617", fontWeight: "900" },
});
