import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";

const REASONS = [
  { code: "CHANGE_OF_PLANS", label: "Change of plans" },
  { code: "HIRED_SOMEONE_ELSE", label: "Hired someone else" },
  { code: "TOO_EXPENSIVE", label: "Too expensive" },
  { code: "SCHEDULING_CONFLICT", label: "Scheduling conflict" },
  { code: "NO_SHOW", label: "No show" },
  { code: "UNRESPONSIVE", label: "Unresponsive" },
  { code: "SAFETY_CONCERN", label: "Safety concern" },
  { code: "DUPLICATE_JOB", label: "Duplicate job" },
  { code: "OTHER", label: "Other" },
] as const;

type ReasonCode = (typeof REASONS)[number]["code"];

export default function CancelJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [reasonCode, setReasonCode] = useState<ReasonCode | null>(null);
  const [details, setDetails] = useState("");
  const [acting, setActing] = useState(false);

  const onSubmit = useCallback(async () => {
    if (!Number.isFinite(jobId)) {
      Alert.alert("Error", "Invalid job id.");
      return;
    }

    if (!reasonCode) {
      Alert.alert("Reason required", "Please select a reason.");
      return;
    }

    if (reasonCode === "OTHER" && details.trim().length < 3) {
      Alert.alert("Details required", "Please add a short explanation.");
      return;
    }

    Alert.alert(
      "Cancel job?",
      "This can’t be undone.",
      [
        { text: "Keep job", style: "cancel" },
        {
          text: "Cancel job",
          style: "destructive",
          onPress: async () => {
            try {
              setActing(true);
              await api.post(`/jobs/${jobId}/cancel`, {
                reasonCode,
                reasonDetails: details.trim() ? details.trim() : undefined,
              });
              Alert.alert("Cancelled", "Job cancelled.");
              router.back();
            } catch (e: any) {
              Alert.alert("Cancel failed", e?.message ?? "Could not cancel job.");
            } finally {
              setActing(false);
            }
          },
        },
      ]
    );
  }, [details, jobId, reasonCode]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Cancel Job</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Why are you cancelling?</Text>

          <View style={{ gap: 10, marginTop: 10 }}>
            {REASONS.map((r) => {
              const selected = reasonCode === r.code;
              return (
                <Pressable
                  key={r.code}
                  style={[styles.reasonRow, selected && styles.reasonRowSelected]}
                  onPress={() => setReasonCode(r.code)}
                >
                  <View style={[styles.radio, selected && styles.radioSelected]} />
                  <Text style={styles.reasonText}>{r.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Details (optional)</Text>
          <TextInput
            style={styles.input}
            placeholder="Add context (optional)"
            placeholderTextColor="#64748b"
            value={details}
            onChangeText={setDetails}
            multiline
          />

          <Pressable
            style={[styles.dangerBtn, acting && styles.btnDisabled]}
            onPress={onSubmit}
            disabled={acting}
          >
            <Text style={styles.dangerText}>{acting ? "Cancelling…" : "Cancel Job"}</Text>
          </Pressable>
        </View>
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
  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14 },
  sectionTitle: { color: "#fff", fontWeight: "900", fontSize: 14 },

  reasonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  reasonRowSelected: { borderColor: "#38bdf8" },
  radio: {
    width: 14,
    height: 14,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#334155",
  },
  radioSelected: { borderColor: "#38bdf8", backgroundColor: "#38bdf8" },
  reasonText: { color: "#e2e8f0", fontWeight: "900" },

  input: {
    marginTop: 10,
    minHeight: 90,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#1e293b",
    padding: 12,
    color: "#e2e8f0",
    textAlignVertical: "top",
  },

  dangerBtn: {
    backgroundColor: "#ef4444",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 14,
  },
  dangerText: { color: "#0b1220", fontWeight: "900" },
  btnDisabled: { opacity: 0.6 },
});
