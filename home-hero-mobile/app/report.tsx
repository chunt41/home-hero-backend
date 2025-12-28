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
import { api } from "../src/lib/apiClient";
import { getErrorMessage } from "../src/lib/getErrorMessage";

type ReportType = "USER" | "JOB" | "MESSAGE";

export default function ReportScreen() {
  const params = useLocalSearchParams<{
    type?: string;
    targetId?: string;
  }>();

  const reportType = useMemo(() => {
    const t = String(params.type ?? "").toUpperCase();
    if (t === "USER" || t === "JOB" || t === "MESSAGE") return t as ReportType;
    return null;
  }, [params.type]);

  const targetIdNum = useMemo(() => {
    const n = Number(params.targetId);
    return Number.isFinite(n) ? n : null;
  }, [params.targetId]);

  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = !!reportType && targetIdNum != null && !!reason.trim();

  const onSubmit = async () => {
    if (!canSubmit || submitting) return;

    try {
      setSubmitting(true);
      await api.post<{ message: string }>("/reports", {
        type: reportType,
        targetId: targetIdNum,
        reason: reason.trim(),
        details: details.trim() ? details.trim() : undefined,
      });

      Alert.alert("Thanks", "Report submitted.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to submit report."));
    } finally {
      setSubmitting(false);
    }
  };

  const invalid = !reportType || targetIdNum == null;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Report</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.content}>
        {invalid ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Missing info</Text>
            <Text style={styles.bodyMuted}>
              This screen needs valid {"type"} and {"targetId"} parameters.
            </Text>
            <Pressable style={[styles.secondaryBtn, { marginTop: 12 }]} onPress={() => router.back()}>
              <Text style={styles.secondaryText}>Go Back</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Reporting</Text>
              <Text style={styles.body}>Type: {reportType}</Text>
              <Text style={styles.body}>Target ID: {targetIdNum}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Reason</Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="What happened?"
                placeholderTextColor="#94a3b8"
                style={styles.input}
              />

              <Text style={[styles.sectionTitle, { marginTop: 12 }]}>Details (optional)</Text>
              <TextInput
                value={details}
                onChangeText={setDetails}
                placeholder="Add any extra context"
                placeholderTextColor="#94a3b8"
                style={[styles.input, styles.inputMultiline]}
                multiline
              />
            </View>

            <Pressable
              style={[styles.primaryBtn, (!canSubmit || submitting) && styles.btnDisabled]}
              onPress={onSubmit}
              disabled={!canSubmit || submitting}
            >
              {submitting ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator />
                  <Text style={styles.primaryText}>Submitting…</Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Submit Report</Text>
              )}
            </Pressable>
          </>
        )}
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
  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 8, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },

  input: {
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#fff",
  },
  inputMultiline: { minHeight: 110, textAlignVertical: "top" },

  primaryBtn: {
    marginTop: 14,
    backgroundColor: "#38bdf8",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#020617", fontWeight: "900" },

  secondaryBtn: {
    backgroundColor: "#1e293b",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },
});
