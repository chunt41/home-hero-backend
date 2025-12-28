import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { getErrorMessage } from "../../src/lib/getErrorMessage";

type AdminReport = {
  id: number;
  targetType: "USER" | "JOB" | "MESSAGE" | string;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED" | string;
  reason: string;
  details: string | null;
  adminNotes: string | null;
  createdAt: string;
  reporter: { id: number; name: string | null; email: string; role: string };
  targetUser: { id: number; name: string | null; email: string; role: string } | null;
  targetJob: { id: number; title: string; consumerId: number } | null;
  targetMessage: { id: number; jobId: number; senderId: number; text: string } | null;
};

type ReportsResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  reports: AdminReport[];
};

const COLORS = {
  bg: "#020617",
  card: "#0f172a",
  border: "#1e293b",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#38bdf8",
  warning: "#f59e0b",
  danger: "#ef4444",
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function AdminReportsScreen() {
  const [status, setStatus] = useState<string | null>("OPEN");
  const [type, setType] = useState<string | null>(null);

  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminReport | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [newStatus, setNewStatus] = useState<string>("IN_REVIEW");
  const [adminNotes, setAdminNotes] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const query = useMemo(
    () => ({
      status: status ?? undefined,
      type: type ?? undefined,
      page: 1,
      pageSize: 20,
    }),
    [status, type]
  );

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<ReportsResponse>("/admin/reports", query);
      setData(resp);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load reports.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const openModal = (r: AdminReport) => {
    setSelected(r);
    setNewStatus(r.status === "OPEN" ? "IN_REVIEW" : String(r.status));
    setAdminNotes(r.adminNotes ?? "");
    setModalVisible(true);
  };

  const saveUpdate = async () => {
    if (!selected) return;

    try {
      setSaving(true);
      await api.patch(`/admin/reports/${selected.id}`, {
        status: newStatus,
        adminNotes: adminNotes.trim() ? adminNotes.trim() : undefined,
      });

      setModalVisible(false);
      setSelected(null);
      await fetchReports();
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to update report."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Reports</Text>
        <Pressable onPress={fetchReports} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>↻</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Filters</Text>
          <View style={styles.filterRow}>
            {["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].map((s) => (
              <Pressable
                key={s}
                style={[styles.chip, status === s && styles.chipActive]}
                onPress={() => setStatus(s)}
              >
                <Text style={[styles.chipText, status === s && styles.chipTextActive]}>
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.filterRow, { marginTop: 10 }]}>
            <Pressable
              style={[styles.chip, !type && styles.chipActive]}
              onPress={() => setType(null)}
            >
              <Text style={[styles.chipText, !type && styles.chipTextActive]}>ALL</Text>
            </Pressable>
            {["USER", "JOB", "MESSAGE"].map((t) => (
              <Pressable
                key={t}
                style={[styles.chip, type === t && styles.chipActive]}
                onPress={() => setType(t)}
              >
                <Text style={[styles.chipText, type === t && styles.chipTextActive]}>
                  {t}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={COLORS.accent} />
            <Text style={styles.muted}>Loading…</Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : !data?.reports?.length ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>No reports</Text>
            <Text style={styles.muted}>No items match these filters.</Text>
          </View>
        ) : (
          data.reports.map((r) => (
            <Pressable key={r.id} style={styles.card} onPress={() => openModal(r)}>
              <Text style={styles.sectionTitle}>
                #{r.id} • {r.status} • {r.targetType}
              </Text>
              <Text style={styles.meta}>
                Reporter: {r.reporter.name ?? "User"} ({r.reporter.email})
              </Text>
              <Text style={[styles.body, { marginTop: 8 }]}>{r.reason}</Text>
              {r.details ? <Text style={styles.meta}>Details: {r.details}</Text> : null}
              {r.adminNotes ? <Text style={styles.meta}>Admin notes: {r.adminNotes}</Text> : null}
              <Text style={styles.meta}>Created: {formatDate(r.createdAt)}</Text>
              <Text style={[styles.meta, { marginTop: 10, color: COLORS.accent }]}>
                Tap to update…
              </Text>
            </Pressable>
          ))
        )}
      </ScrollView>

      <Modal transparent visible={modalVisible} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Update Report #{selected?.id ?? ""}
            </Text>

            <Text style={styles.modalLabel}>Status</Text>
            <View style={styles.filterRow}>
              {["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].map((s) => (
                <Pressable
                  key={s}
                  style={[styles.chip, newStatus === s && styles.chipActive]}
                  onPress={() => setNewStatus(s)}
                >
                  <Text style={[styles.chipText, newStatus === s && styles.chipTextActive]}>
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.modalLabel, { marginTop: 12 }]}>Admin notes (optional)</Text>
            <TextInput
              value={adminNotes}
              onChangeText={setAdminNotes}
              placeholder="Notes for internal tracking"
              placeholderTextColor={COLORS.textMuted}
              style={styles.input}
              multiline
            />

            <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
              <Pressable
                style={[styles.secondaryBtn, { flex: 1 }]}
                onPress={() => {
                  setModalVisible(false);
                  setSelected(null);
                }}
                disabled={saving}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>

              <Pressable
                style={[styles.primaryBtn, { flex: 1 }, saving && styles.btnDisabled]}
                onPress={saveUpdate}
                disabled={saving}
              >
                {saving ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <ActivityIndicator />
                    <Text style={styles.primaryText}>Saving…</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },

  header: {
    paddingBottom: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.card,
  },
  backBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  backText: { color: COLORS.accent, fontWeight: "800" },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: "900" },
  headerBtn: {
    width: 44,
    height: 36,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headerBtnText: { color: COLORS.accent, fontWeight: "900", fontSize: 16 },

  content: { padding: 16, paddingBottom: 26 },
  center: { padding: 16, alignItems: "center", justifyContent: "center" },
  muted: { color: COLORS.textMuted, marginTop: 10 },
  error: { color: "#fca5a5", fontWeight: "800" },

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sectionTitle: { color: COLORS.text, fontWeight: "900", marginBottom: 6, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  meta: { color: COLORS.textMuted, marginTop: 6, fontSize: 12 },

  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipText: { color: COLORS.textMuted, fontWeight: "900", fontSize: 12 },
  chipTextActive: { color: COLORS.bg },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    padding: 16,
    justifyContent: "center",
  },
  modalCard: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: { color: COLORS.text, fontSize: 16, fontWeight: "900" },
  modalLabel: { color: COLORS.textMuted, marginTop: 10, fontWeight: "900" },

  input: {
    marginTop: 8,
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    minHeight: 90,
    textAlignVertical: "top",
  },

  primaryBtn: {
    backgroundColor: COLORS.accent,
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: COLORS.bg, fontWeight: "900" },

  secondaryBtn: {
    backgroundColor: "#1e293b",
    padding: 12,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },
});
