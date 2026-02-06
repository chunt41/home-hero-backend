import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../src/lib/apiClient";
import { getErrorMessage } from "../src/lib/getErrorMessage";

const REASON_CODES = [
  { code: "WORK_NOT_COMPLETED", label: "Work not completed" },
  { code: "QUALITY_ISSUE", label: "Quality issue" },
  { code: "PAYMENT_ISSUE", label: "Payment issue" },
  { code: "SAFETY", label: "Safety concern" },
  { code: "OTHER", label: "Other" },
] as const;

type ReasonCode = (typeof REASON_CODES)[number]["code"];

export default function OpenDisputeScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const numericJobId = useMemo(() => Number(jobId), [jobId]);

  const [reasonCode, setReasonCode] = useState<ReasonCode>("QUALITY_ISSUE");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const invalid = !Number.isFinite(numericJobId);

  const onSubmit = async () => {
    if (invalid || submitting) return;

    try {
      setSubmitting(true);
      await api.post(`/jobs/${numericJobId}/disputes`, {
        reasonCode,
        description: description.trim() ? description.trim() : undefined,
      });

      Alert.alert(
        "Dispute opened",
        "Thanks — our team will review this dispute.",
        [{ text: "OK", onPress: () => router.back() }]
      );
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to open dispute."));
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
        <Text style={styles.headerTitle}>Open Dispute</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {invalid ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Invalid job</Text>
            <Text style={styles.bodyMuted}>Missing or invalid jobId.</Text>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Job</Text>
              <Text style={styles.body}>Job ID: {numericJobId}</Text>
              <Text style={[styles.bodyMuted, { marginTop: 8 }]}>
                Please keep details factual. Don’t include phone numbers or emails.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Reason</Text>
              <View style={{ gap: 10, marginTop: 6 }}>
                {REASON_CODES.map((r) => {
                  const selected = r.code === reasonCode;
                  return (
                    <Pressable
                      key={r.code}
                      onPress={() => setReasonCode(r.code)}
                      style={[styles.reasonRow, selected && styles.reasonRowSelected]}
                    >
                      <Text style={styles.reasonText}>{r.label}</Text>
                      <Text style={styles.reasonDot}>{selected ? "●" : "○"}</Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Details (optional)</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="What happened?"
                placeholderTextColor="#94a3b8"
                style={[styles.input, styles.inputMultiline]}
                multiline
              />
            </View>

            <Pressable
              style={[styles.primaryBtn, submitting && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator />
                  <Text style={styles.primaryText}>Submitting…</Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Open Dispute</Text>
              )}
            </Pressable>
          </>
        )}
      </ScrollView>
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

  content: { padding: 16, paddingBottom: 26 },

  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 8, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },

  reasonRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  reasonRowSelected: {
    borderColor: "#38bdf8",
  },
  reasonText: { color: "#e2e8f0", fontWeight: "800" },
  reasonDot: { color: "#38bdf8", fontWeight: "900" },

  input: {
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fff",
    marginTop: 8,
  },
  inputMultiline: { minHeight: 130, textAlignVertical: "top" },

  primaryBtn: {
    marginTop: 14,
    backgroundColor: "#ef4444",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#0b1220", fontWeight: "900" },
  btnDisabled: { opacity: 0.6 },
});
