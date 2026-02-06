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
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { api } from "../../src/lib/apiClient";
import { getErrorMessage } from "../../src/lib/getErrorMessage";

type VerificationStatus = "NONE" | "PENDING" | "VERIFIED" | "REJECTED" | string;

type VerificationItem = {
  providerId: number;
  status: VerificationStatus;
  method: "ID" | "BACKGROUND_CHECK" | null;
  providerSubmittedAt: string | null;
  verifiedAt: string | null;
  updatedAt: string;
  metadataJson: unknown;
  provider: { id: number; name: string | null; email: string; phone: string | null };
  attachmentCount: number;
};

type ListResponse = {
  items: VerificationItem[];
};

const COLORS = {
  bg: "#020617",
  card: "#0f172a",
  border: "#1e293b",
  text: "#f1f5f9",
  textMuted: "#94a3b8",
  accent: "#38bdf8",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function statusColor(status: VerificationStatus) {
  if (status === "VERIFIED") return COLORS.success;
  if (status === "PENDING") return COLORS.warning;
  if (status === "REJECTED") return COLORS.danger;
  return COLORS.textMuted;
}

export default function AdminProviderVerificationsScreen() {
  const [status, setStatus] = useState<"PENDING" | "VERIFIED" | "REJECTED" | "ALL">("PENDING");
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<VerificationItem | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [notes, setNotes] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const query = useMemo(() => {
    return {
      status: status === "ALL" ? undefined : status,
    };
  }, [status]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get<ListResponse>("/admin/provider-verifications", query);
      setData(resp);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load provider verifications.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const openDecision = (item: VerificationItem, d: "approve" | "reject") => {
    setSelected(item);
    setDecision(d);
    setNotes("");
    setReason("");
  };

  const closeDecision = () => {
    setSelected(null);
    setDecision(null);
    setNotes("");
    setReason("");
  };

  const submitDecision = useCallback(async () => {
    if (!selected || !decision) return;

    try {
      setSaving(true);

      const body: any = {
        notes: notes.trim() ? notes.trim() : undefined,
      };
      if (decision === "reject") {
        body.reason = reason.trim() ? reason.trim() : undefined;
      }

      const endpoint =
        decision === "approve"
          ? `/admin/provider-verifications/${selected.providerId}/approve`
          : `/admin/provider-verifications/${selected.providerId}/reject`;

      await api.post(endpoint, body);

      closeDecision();
      await fetchList();
    } catch (e: any) {
      Alert.alert("Error", getErrorMessage(e, "Failed to update verification."));
    } finally {
      setSaving(false);
    }
  }, [selected, decision, notes, reason, fetchList]);

  const items = data?.items ?? [];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialCommunityIcons name="chevron-left" size={24} color={COLORS.accent} />
        </Pressable>
        <Text style={styles.title}>Provider Verifications</Text>
        <Pressable onPress={fetchList}>
          <MaterialCommunityIcons name="refresh" size={22} color={COLORS.accent} />
        </Pressable>
      </View>

      <View style={styles.filtersRow}>
        {([
          { key: "PENDING", label: "Pending" },
          { key: "VERIFIED", label: "Verified" },
          { key: "REJECTED", label: "Rejected" },
          { key: "ALL", label: "All" },
        ] as const).map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setStatus(t.key)}
            style={[styles.filterPill, status === t.key && styles.filterPillActive]}
          >
            <Text style={[styles.filterText, status === t.key && styles.filterTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={COLORS.accent} />
          <Text style={styles.muted}>Loading…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.muted, { color: COLORS.warning, fontWeight: "700" }]}>Failed to load</Text>
          <Text style={styles.muted}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchList}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.count}>{items.length} result(s)</Text>

          {items.map((it) => (
            <View key={String(it.providerId)} style={styles.card}>
              <View style={styles.cardTopRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.providerName} numberOfLines={1}>
                    {it.provider.name ?? "Provider"}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {it.provider.email} {it.provider.phone ? `• ${it.provider.phone}` : ""}
                  </Text>
                </View>

                <View style={[styles.statusPill, { borderColor: statusColor(it.status) }]}
                >
                  <MaterialCommunityIcons
                    name={
                      it.status === "VERIFIED"
                        ? "check-decagram"
                        : it.status === "PENDING"
                          ? "clock-outline"
                          : it.status === "REJECTED"
                            ? "close-octagon"
                            : "shield-outline"
                    }
                    size={14}
                    color={statusColor(it.status)}
                  />
                  <Text style={[styles.statusText, { color: statusColor(it.status) }]}>
                    {String(it.status)}
                  </Text>
                </View>
              </View>

              <View style={styles.kvRow}>
                <Text style={styles.k}>Method</Text>
                <Text style={styles.v}>{it.method ?? "—"}</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>Submitted</Text>
                <Text style={styles.v}>{formatDate(it.providerSubmittedAt)}</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>Verified</Text>
                <Text style={styles.v}>{formatDate(it.verifiedAt)}</Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={styles.k}>Docs</Text>
                <Text style={styles.v}>{it.attachmentCount}</Text>
              </View>

              <View style={styles.actionsRow}>
                <Pressable
                  style={styles.secondaryBtn}
                  onPress={() => router.push({ pathname: "/provider/[id]", params: { id: String(it.providerId) } } as any)}
                >
                  <MaterialCommunityIcons name="account" size={16} color={COLORS.accent} />
                  <Text style={styles.secondaryBtnText}>Profile</Text>
                </Pressable>

                <View style={{ flex: 1 }} />

                <Pressable
                  style={[styles.rejectBtn, saving && styles.btnDisabled]}
                  disabled={saving}
                  onPress={() => openDecision(it, "reject")}
                >
                  <Text style={styles.rejectText}>Reject</Text>
                </Pressable>

                <Pressable
                  style={[styles.approveBtn, saving && styles.btnDisabled]}
                  disabled={saving}
                  onPress={() => openDecision(it, "approve")}
                >
                  <Text style={styles.approveText}>Approve</Text>
                </Pressable>
              </View>
            </View>
          ))}

          {!items.length ? <Text style={styles.muted}>No items.</Text> : null}
        </ScrollView>
      )}

      <Modal
        visible={!!selected && !!decision}
        transparent
        animationType="slide"
        onRequestClose={closeDecision}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {decision === "approve" ? "Approve verification" : "Reject verification"}
            </Text>
            <Text style={styles.modalSubtitle} numberOfLines={2}>
              {selected?.provider.name ?? "Provider"} • #{selected?.providerId}
            </Text>

            {decision === "reject" ? (
              <>
                <Text style={styles.modalLabel}>Reason (optional)</Text>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="E.g., document unreadable"
                  placeholderTextColor={COLORS.textMuted}
                  style={styles.modalInput}
                />
              </>
            ) : null}

            <Text style={styles.modalLabel}>Notes (optional)</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Admin notes…"
              placeholderTextColor={COLORS.textMuted}
              style={[styles.modalInput, styles.modalTextarea]}
              multiline
              numberOfLines={4}
            />

            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={closeDecision} disabled={saving}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalPrimary, saving && styles.btnDisabled]}
                onPress={submitDecision}
                disabled={saving}
              >
                <Text style={styles.modalPrimaryText}>
                  {saving ? "Saving…" : decision === "approve" ? "Approve" : "Reject"}
                </Text>
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
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800" },
  filtersRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    flexWrap: "wrap",
  },
  filterPill: {
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  filterPillActive: {
    borderColor: COLORS.accent,
  },
  filterText: {
    color: COLORS.textMuted,
    fontWeight: "800",
    fontSize: 12,
  },
  filterTextActive: {
    color: COLORS.accent,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 },
  muted: { color: COLORS.textMuted, textAlign: "center" },
  retryBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border },
  retryText: { color: COLORS.accent, fontWeight: "900" },
  scroll: { padding: 16, gap: 12, paddingBottom: 30 },
  count: { color: COLORS.textMuted, fontWeight: "700" },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  cardTopRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  providerName: { color: COLORS.text, fontSize: 15, fontWeight: "900" },
  meta: { color: COLORS.textMuted, marginTop: 2 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusText: { fontWeight: "900", fontSize: 12 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  k: { color: COLORS.textMuted, fontWeight: "800" },
  v: { color: COLORS.text, fontWeight: "700" },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  secondaryBtnText: { color: COLORS.accent, fontWeight: "900" },
  approveBtn: {
    backgroundColor: "rgba(16, 185, 129, 0.18)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.35)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  approveText: { color: COLORS.success, fontWeight: "900" },
  rejectBtn: {
    backgroundColor: "rgba(239, 68, 68, 0.16)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.35)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  rejectText: { color: COLORS.danger, fontWeight: "900" },
  btnDisabled: { opacity: 0.6 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 10,
  },
  modalTitle: { color: COLORS.text, fontSize: 16, fontWeight: "900" },
  modalSubtitle: { color: COLORS.textMuted },
  modalLabel: { color: COLORS.textMuted, fontWeight: "800", marginTop: 6 },
  modalInput: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    backgroundColor: COLORS.bg,
  },
  modalTextarea: { minHeight: 110, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border },
  modalCancelText: { color: COLORS.textMuted, fontWeight: "900" },
  modalPrimary: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.accent },
  modalPrimaryText: { color: COLORS.bg, fontWeight: "900" },
});
