import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Modal,
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
  const [confirmVisible, setConfirmVisible] = useState(false);

  const selectedReasonLabel = useMemo(() => {
    if (!reasonCode) return null;
    const r = REASONS.find((x) => x.code === reasonCode);
    return r?.label ?? reasonCode;
  }, [reasonCode]);

  const validate = useCallback((): { ok: true } | { ok: false; title: string; message: string } => {
    if (!Number.isFinite(jobId)) {
      return { ok: false, title: "Error", message: "Invalid job id." };
    }
    if (!reasonCode) {
      return { ok: false, title: "Reason required", message: "Please select a reason." };
    }
    if (reasonCode === "OTHER" && details.trim().length < 3) {
      return { ok: false, title: "Details required", message: "Please add a short explanation." };
    }
    return { ok: true };
  }, [details, jobId, reasonCode]);

  const confirmCancel = useCallback(async () => {
    const v = validate();
    if (!v.ok) {
      Alert.alert(v.title, v.message);
      return;
    }

    if (!reasonCode) return;

    try {
      setActing(true);
      await api.post(`/jobs/${jobId}/cancel`, {
        reasonCode,
        reasonDetails: details.trim() ? details.trim() : undefined,
      });
      setConfirmVisible(false);
      Alert.alert("Cancelled", "Job cancelled.");
      router.back();
    } catch (e: any) {
      Alert.alert("Cancel failed", e?.message ?? "Could not cancel job.");
    } finally {
      setActing(false);
    }
  }, [details, jobId, reasonCode, validate]);

  const onSubmit = useCallback(async () => {
    const v = validate();
    if (!v.ok) {
      Alert.alert(v.title, v.message);
      return;
    }

    setConfirmVisible(true);
  }, [validate]);

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

      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => (acting ? null : setConfirmVisible(false))}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Cancel job?</Text>
            <Text style={styles.modalBody}>This can’t be undone.</Text>

            {selectedReasonLabel ? (
              <Text style={styles.modalBodyMuted}>
                Reason: {selectedReasonLabel}
                {details.trim() ? ` — ${details.trim()}` : ""}
              </Text>
            ) : null}

            <View style={styles.modalActions}>
              <Pressable
                style={[styles.modalBtn, styles.modalBtnSecondary, acting && styles.btnDisabled]}
                onPress={() => setConfirmVisible(false)}
                disabled={acting}
              >
                <Text style={styles.modalBtnSecondaryText}>Keep job</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.modalBtnDanger, acting && styles.btnDisabled]}
                onPress={confirmCancel}
                disabled={acting}
              >
                <Text style={styles.modalBtnDangerText}>{acting ? "Cancelling…" : "Cancel job"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "center",
    padding: 18,
  },
  modalCard: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  modalTitle: { color: "#fff", fontWeight: "900", fontSize: 16 },
  modalBody: { color: "#e2e8f0", marginTop: 8, lineHeight: 20 },
  modalBodyMuted: { color: "#cbd5e1", marginTop: 10, lineHeight: 20 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  modalBtn: { flex: 1, padding: 12, borderRadius: 12, alignItems: "center" },
  modalBtnSecondary: { backgroundColor: "#1e293b" },
  modalBtnSecondaryText: { color: "#e2e8f0", fontWeight: "900" },
  modalBtnDanger: { backgroundColor: "#ef4444" },
  modalBtnDangerText: { color: "#0b1220", fontWeight: "900" },
});
