import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";

type Attachment = {
  id: number;
  url: string;
  type: string | null;
  createdAt: string;
};

type ProviderSummary = {
  id: number;
  name: string | null;
  location: string | null;
  rating: number | null;
  reviewCount: number;
};

type AwardedBid = {
  id: number;
  amount: number;
  message: string;
  createdAt: string;
  provider: ProviderSummary;
};

type ConsumerJobDetail = {
  id: number;
  title: string;
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  location: string | null;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | string;
  createdAt: string;
  bidCount: number;
  attachments: Attachment[];

  // ✅ new field from backend
  awardedBid: AwardedBid | null;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function ConsumerJobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [job, setJob] = useState<ConsumerJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<null | "cancel" | "complete">(null);
  const [error, setError] = useState<string | null>(null);

  const fetchJob = useCallback(async () => {
    if (!Number.isFinite(jobId)) {
      setError("Invalid job id.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await api.get<ConsumerJobDetail>(`/consumer/jobs/${jobId}`);
      setJob(data);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load job.");
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  const budgetText =
    job?.budgetMin != null || job?.budgetMax != null
      ? `$${job?.budgetMin ?? "?"} - $${job?.budgetMax ?? "?"}`
      : "Budget not listed";

  const canCancel = job?.status === "OPEN" || job?.status === "IN_PROGRESS";
  const canComplete = job?.status === "IN_PROGRESS";

  const doCancel = useCallback(() => {
    if (!job) return;

    Alert.alert(
      "Cancel this job?",
      "This will set the job to CANCELLED and decline all bids.",
      [
        { text: "No", style: "cancel" },
        {
          text: "Yes, cancel",
          style: "destructive",
          onPress: async () => {
            try {
              setBusyAction("cancel");

              // optimistic UI (safe; fetchJob will normalize)
              setJob((prev) => (prev ? { ...prev, status: "CANCELLED" } : prev));

              await api.post(`/jobs/${job.id}/cancel`, {});
              await fetchJob();
            } catch (e: any) {
              await fetchJob();
              Alert.alert("Cancel failed", e?.message ?? "Could not cancel job.");
            } finally {
              setBusyAction(null);
            }
          },
        },
      ]
    );
  }, [job, fetchJob]);

  const doComplete = useCallback(() => {
    if (!job) return;

    Alert.alert(
      "Mark as completed?",
      "Only do this when the work is finished.",
      [
        { text: "Not yet", style: "cancel" },
        {
          text: "Yes, completed",
          style: "default",
          onPress: async () => {
            try {
              setBusyAction("complete");

              // optimistic UI (safe; fetchJob will normalize)
              setJob((prev) => (prev ? { ...prev, status: "COMPLETED" } : prev));

              await api.post(`/jobs/${job.id}/complete`, {});
              await fetchJob();
            } catch (e: any) {
              await fetchJob();
              Alert.alert("Complete failed", e?.message ?? "Could not complete job.");
            } finally {
              setBusyAction(null);
            }
          },
        },
      ]
    );
  }, [job, fetchJob]);

  const goToBids = useCallback(() => {
    router.push(`/consumer/job/${jobId}/bids`);
  }, [jobId]);

  const goToMessages = useCallback(() => {
    router.push(`/messages/${jobId}`);
  }, [jobId]);

  const goToAddAttachment = useCallback(() => {
    router.push(`/consumer/add-attachment?jobId=${jobId}`);
  }, [jobId]);

  const goToLeaveReview = useCallback(() => {
    router.push(`/consumer/leave-review?jobId=${jobId}`);
  }, [jobId]);

  const goToReportJob = useCallback(() => {
    if (!job) return;
    router.push(`/report?type=JOB&targetId=${job.id}`);
  }, [job]);

  const goToReportAwardedProvider = useCallback(() => {
    if (!job?.awardedBid?.provider?.id) return;
    router.push(`/report?type=USER&targetId=${job.awardedBid.provider.id}`);
  }, [job]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          My Job
        </Text>
        <Pressable onPress={fetchJob} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>↻</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading job…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={fetchJob}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : !job ? (
        <View style={styles.center}>
          <Text style={styles.muted}>Job not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{job.title}</Text>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Status</Text>
            <Text style={styles.body}>{job.status}</Text>
            <Text style={styles.metaSmall}>Created: {formatDate(job.createdAt)}</Text>
          </View>

          {/* ✅ Awarded Provider */}
          {job.awardedBid ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Awarded Provider</Text>

              <View style={styles.providerRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bodyStrong}>
                    {job.awardedBid.provider.name ?? "Provider"}
                  </Text>

                  {job.awardedBid.provider.location ? (
                    <Text style={styles.bodyMuted}>📍 {job.awardedBid.provider.location}</Text>
                  ) : (
                    <Text style={styles.bodyMuted}>📍 Location not listed</Text>
                  )}

                  <Text style={styles.bodyMuted}>
                    ⭐ {job.awardedBid.provider.rating ?? "—"} (
                    {job.awardedBid.provider.reviewCount ?? 0})
                  </Text>
                </View>

                <View style={styles.badgeAwarded}>
                  <Text style={styles.badgeAwardedText}>AWARDED</Text>
                </View>
              </View>

              <View style={styles.actionsRow}>
                <Pressable style={styles.primaryBtn} onPress={goToMessages}>
                  <Text style={styles.primaryText}>Open Messages</Text>
                </Pressable>

                <Pressable style={styles.secondaryBtn} onPress={goToBids}>
                  <Text style={styles.secondaryText}>View Bids</Text>
                </Pressable>
              </View>

              <Text style={styles.metaSmall}>
                Bid: ${job.awardedBid.amount} • {formatDate(job.awardedBid.createdAt)}
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Awarded Provider</Text>
              <Text style={styles.bodyMuted}>No provider awarded yet.</Text>

              <Pressable style={styles.primaryBtn} onPress={goToBids}>
                <Text style={styles.primaryText}>View Bids ({job.bidCount})</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Budget</Text>
            <Text style={styles.body}>{budgetText}</Text>
          </View>

          {job.location ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Location</Text>
              <Text style={styles.body}>📍 {job.location}</Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Description</Text>
            <Text style={styles.body}>{job.description ?? "(no description)"}</Text>
          </View>

          {/* Attachments */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Attachments</Text>

            {job.attachments?.length ? (
              job.attachments.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => Linking.openURL(a.url)}
                  style={styles.attachmentRow}
                >
                  <Text style={styles.attachmentText} numberOfLines={1}>
                    {a.type ? `${a.type}: ` : ""}
                    {a.url}
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text style={styles.bodyMuted}>No attachments yet.</Text>
            )}

            <Pressable style={styles.secondaryBtnWide} onPress={goToAddAttachment}>
              <Text style={styles.secondaryText}>Add Attachment</Text>
            </Pressable>
          </View>

          {/* Review */}
          {job.status === "COMPLETED" && job.awardedBid ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Review Provider</Text>
              <Text style={styles.bodyMuted}>
                Leave or update your review for the awarded provider.
              </Text>
              <Pressable style={styles.primaryBtn} onPress={goToLeaveReview}>
                <Text style={styles.primaryText}>Leave Review</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Safety */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Safety</Text>
            <Pressable style={styles.dangerBtn} onPress={goToReportJob}>
              <Text style={styles.dangerText}>Report Job</Text>
            </Pressable>

            {job.awardedBid ? (
              <Pressable
                style={[styles.dangerBtn, { marginTop: 10 }]}
                onPress={goToReportAwardedProvider}
              >
                <Text style={styles.dangerText}>Report Awarded Provider</Text>
              </Pressable>
            ) : null}
          </View>

          {/* ✅ Lifecycle actions */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Job Actions</Text>

            {!canCancel && !canComplete ? (
              <Text style={styles.bodyMuted}>No actions available for this status.</Text>
            ) : null}

            {canComplete ? (
              <Pressable
                style={[styles.primaryBtn, busyAction && styles.btnDisabled]}
                disabled={!!busyAction}
                onPress={doComplete}
              >
                <Text style={styles.primaryText}>
                  {busyAction === "complete" ? "Marking completed…" : "Mark Completed"}
                </Text>
              </Pressable>
            ) : null}

            {canCancel ? (
              <Pressable
                style={[
                  styles.dangerBtn,
                  busyAction && styles.btnDisabled,
                  canComplete ? { marginTop: 10 } : { marginTop: 0 },
                ]}
                disabled={!!busyAction}
                onPress={doCancel}
              >
                <Text style={styles.dangerText}>
                  {busyAction === "cancel" ? "Cancelling…" : "Cancel Job"}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* Utility */}
          <Pressable style={styles.secondaryBtnWide} onPress={fetchJob}>
            <Text style={styles.secondaryText}>Refresh</Text>
          </Pressable>
        </ScrollView>
      )}
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
  headerBtn: {
    width: 44,
    height: 36,
    borderRadius: 12,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#111827",
  },
  headerBtnText: { color: "#38bdf8", fontWeight: "900", fontSize: 16 },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  muted: { color: "#cbd5e1", marginTop: 10 },
  error: { color: "#fca5a5", marginBottom: 12 },

  retryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "900" },

  content: { padding: 16, paddingBottom: 26 },
  title: { color: "#fff", fontSize: 22, fontWeight: "900", marginBottom: 10 },

  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 6, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyStrong: { color: "#fff", fontSize: 16, fontWeight: "900" },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },
  metaSmall: { color: "#94a3b8", marginTop: 8, fontSize: 12 },

  attachmentRow: {
    paddingVertical: 10,
    paddingHorizontal: 10,
    backgroundColor: "#020617",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginTop: 10,
  },
  attachmentText: { color: "#e2e8f0", fontWeight: "800" },

  providerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 6 },

  badgeAwarded: {
    backgroundColor: "#0ea5e9",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  badgeAwardedText: { color: "#020617", fontWeight: "900", fontSize: 12 },

  actionsRow: { flexDirection: "row", gap: 10, marginTop: 12 },

  primaryBtn: {
    flex: 1,
    marginTop: 10,
    backgroundColor: "#38bdf8",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#020617", fontWeight: "900" },

  secondaryBtn: {
    flex: 1,
    marginTop: 10,
    backgroundColor: "#1e293b",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryBtnWide: {
    marginTop: 12,
    backgroundColor: "#1e293b",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  dangerBtn: {
    backgroundColor: "#ef4444",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  dangerText: { color: "#0b1220", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },
});
