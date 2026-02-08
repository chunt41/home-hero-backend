import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";
import { useAuth } from "../../../src/context/AuthContext";
import { JobTimeline } from "../../../src/components/JobTimeline";

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
  status:
    | "OPEN"
    | "AWARDED"
    | "IN_PROGRESS"
    | "COMPLETED_PENDING_CONFIRMATION"
    | "COMPLETED"
    | "DISPUTED"
    | "CANCELLED"
    | string;
  createdAt: string;
  bidCount: number;
  attachments: Attachment[];

  awardedAt: string | null;
  cancelledAt: string | null;
  cancellationReasonCode: string | null;
  cancellationReasonDetails: string | null;
  cancellationReasonLabel?: string | null;

  completionPendingForUserId: number | null;
  completedAt: string | null;

  // ✅ new field from backend
  awardedBid: AwardedBid | null;
};

type Appointment = {
  id: number;
  jobId: number;
  providerId: number;
  consumerId: number;
  startAt: string;
  endAt: string;
  status: "PROPOSED" | "CONFIRMED" | "CANCELLED" | string;
  createdAt: string;
  updatedAt: string;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatLocalRange(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} - ${endIso}`;
  }
  return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
}

function isHHMM(s: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim());
}

function isYYYYMMDD(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

export default function ConsumerJobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const { user } = useAuth();

  const [job, setJob] = useState<ConsumerJobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<null | "markComplete" | "confirmComplete">(null);
  const [error, setError] = useState<string | null>(null);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState<string | null>(null);
  const [appointmentsActing, setAppointmentsActing] = useState<null | { id: number; action: "propose" | "cancel" }>(null);

  const [proposeDate, setProposeDate] = useState(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });
  const [proposeStartTime, setProposeStartTime] = useState("09:00");
  const [proposeDurationMins, setProposeDurationMins] = useState("60");

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

  const fetchAppointments = useCallback(async () => {
    if (!Number.isFinite(jobId)) return;
    setAppointmentsLoading(true);
    setAppointmentsError(null);
    try {
      const data = await api.get<{ items: Appointment[] }>(`/jobs/${jobId}/appointments`);
      setAppointments(data.items ?? []);
    } catch (e: any) {
      setAppointmentsError(e?.message ?? "Failed to load appointments.");
      setAppointments([]);
    } finally {
      setAppointmentsLoading(false);
    }
  }, [jobId]);

  useFocusEffect(
    useCallback(() => {
      fetchJob();
      fetchAppointments();
    }, [fetchJob, fetchAppointments])
  );

  const budgetText =
    job?.budgetMin != null || job?.budgetMax != null
      ? `$${job?.budgetMin ?? "?"} - $${job?.budgetMax ?? "?"}`
      : "Budget not listed";

  const canCancel = job?.status === "OPEN" || job?.status === "AWARDED" || job?.status === "IN_PROGRESS";
  const canComplete = job?.status === "IN_PROGRESS";
  const canConfirmComplete =
    job?.status === "COMPLETED_PENDING_CONFIRMATION" &&
    !!user?.id &&
    job?.completionPendingForUserId === user.id;

  const canOpenDispute = useMemo(() => {
    if (!job?.awardedBid) return false;
    return (
      job.status === "IN_PROGRESS" ||
      job.status === "COMPLETED_PENDING_CONFIRMATION" ||
      job.status === "COMPLETED"
    );
  }, [job]);

  const goToCancelJob = useCallback(() => {
    if (!job) return;
    router.push(`/job/${job.id}/cancel`);
  }, [job]);

  const doMarkComplete = useCallback(() => {
    if (!job) return;

    Alert.alert(
      "Mark as completed?",
      "This requests completion confirmation from the other participant.",
      [
        { text: "Not yet", style: "cancel" },
        {
          text: "Yes, completed",
          style: "default",
          onPress: async () => {
            try {
              setBusyAction("markComplete");

              // optimistic UI (safe; fetchJob will normalize)
              setJob((prev) =>
                prev
                  ? {
                      ...prev,
                      status: "COMPLETED_PENDING_CONFIRMATION",
                    }
                  : prev
              );

              await api.post(`/jobs/${job.id}/mark-complete`, {});
              await fetchJob();

              Alert.alert(
                "Completion requested",
                "Waiting for the other participant to confirm completion."
              );
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

  const doConfirmComplete = useCallback(() => {
    if (!job) return;

    Alert.alert("Confirm completion?", "Confirm that the work is finished.", [
      { text: "Not yet", style: "cancel" },
      {
        text: "Yes, confirm",
        style: "default",
        onPress: async () => {
          try {
            setBusyAction("confirmComplete");
            const resp = await api.post<{ job: ConsumerJobDetail }>(
              `/jobs/${job.id}/confirm-complete`,
              {}
            );
            await fetchJob();

            if (resp?.job?.status === "COMPLETED" && job.awardedBid) {
              Alert.alert(
                "Job completed",
                "Would you like to leave a review for the provider?",
                [
                  { text: "Later", style: "cancel" },
                  {
                    text: "Leave review",
                    onPress: () => router.push(`/leave-review?jobId=${job.id}`),
                  },
                ]
              );
            }
          } catch (e: any) {
            await fetchJob();
            Alert.alert(
              "Confirm failed",
              e?.message ?? "Could not confirm completion."
            );
          } finally {
            setBusyAction(null);
          }
        },
      },
    ]);
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
    router.push(`/leave-review?jobId=${jobId}`);
  }, [jobId]);

  const goToReportJob = useCallback(() => {
    if (!job) return;
    router.push(`/report?type=JOB&targetId=${job.id}`);
  }, [job]);

  const goToReportAwardedProvider = useCallback(() => {
    if (!job?.awardedBid?.provider?.id) return;
    router.push(`/report?type=USER&targetId=${job.awardedBid.provider.id}`);
  }, [job]);

  const goToOpenDispute = useCallback(() => {
    if (!job) return;
    router.push({ pathname: "/open-dispute", params: { jobId: String(job.id) } } as any);
  }, [job]);

  const onProposeAppointment = useCallback(async () => {
    if (!job) return;
    if (!job.awardedBid) {
      Alert.alert("Not awarded", "Award a provider before scheduling.");
      return;
    }
    if (job.status !== "AWARDED" && job.status !== "IN_PROGRESS") {
      Alert.alert("Not ready", `Scheduling is not available in status ${job.status}.`);
      return;
    }

    const dateStr = proposeDate.trim();
    const timeStr = proposeStartTime.trim();
    const duration = Number(proposeDurationMins.trim());

    if (!isYYYYMMDD(dateStr)) {
      Alert.alert("Invalid date", "Use YYYY-MM-DD.");
      return;
    }
    if (!isHHMM(timeStr)) {
      Alert.alert("Invalid time", "Use HH:MM in 24-hour format.");
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) {
      Alert.alert("Invalid duration", "Enter minutes between 1 and 1440.");
      return;
    }

    const startLocal = new Date(`${dateStr}T${timeStr}:00`);
    if (Number.isNaN(startLocal.getTime())) {
      Alert.alert("Invalid start", "Could not parse the provided date/time.");
      return;
    }
    const endLocal = new Date(startLocal.getTime() + duration * 60_000);

    setAppointmentsActing({ id: -1, action: "propose" });
    try {
      await api.post(`/jobs/${job.id}/appointments/propose`, {
        startAt: startLocal.toISOString(),
        endAt: endLocal.toISOString(),
      });
      await fetchAppointments();
      Alert.alert("Proposed", "Sent proposed appointment to the provider.");
    } catch (e: any) {
      Alert.alert("Propose failed", e?.message ?? "Could not propose appointment");
    } finally {
      setAppointmentsActing(null);
    }
  }, [job, proposeDate, proposeStartTime, proposeDurationMins, fetchAppointments]);

  const onCancelAppointment = useCallback(
    (appt: Appointment) => {
      Alert.alert("Cancel appointment?", "This will mark the appointment as cancelled.", [
        { text: "No", style: "cancel" },
        {
          text: "Yes, cancel",
          style: "destructive",
          onPress: async () => {
            setAppointmentsActing({ id: appt.id, action: "cancel" });
            try {
              await api.post(`/appointments/${appt.id}/cancel`, {});
              await fetchAppointments();
            } catch (e: any) {
              Alert.alert("Cancel failed", e?.message ?? "Could not cancel appointment");
            } finally {
              setAppointmentsActing(null);
            }
          },
        },
      ]);
    },
    [fetchAppointments]
  );

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

          <JobTimeline
            job={{
              status: job.status,
              createdAt: job.createdAt,
              awardedAt: job.awardedAt ?? null,
              completedAt: job.completedAt ?? null,
              cancelledAt: job.cancelledAt ?? null,
              cancellationReasonCode: job.cancellationReasonCode ?? null,
              cancellationReasonDetails: job.cancellationReasonDetails ?? null,
            }}
          />

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Status</Text>
            <Text style={styles.body}>{job.status}</Text>
            {job.status === "CANCELLED" && (job.cancellationReasonLabel || job.cancellationReasonCode) ? (
              <Text style={styles.bodyMuted}>
                Reason: {job.cancellationReasonLabel ?? job.cancellationReasonCode}
                {job.cancellationReasonDetails?.trim() ? ` — ${job.cancellationReasonDetails.trim()}` : ""}
              </Text>
            ) : null}
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

          {/* Scheduling */}
          {job.awardedBid ? (
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.sectionTitle}>Scheduling</Text>
                <Pressable onPress={fetchAppointments} disabled={appointmentsLoading}>
                  <Text style={styles.sectionLink}>{appointmentsLoading ? "…" : "Refresh"}</Text>
                </Pressable>
              </View>

              {job.status !== "AWARDED" && job.status !== "IN_PROGRESS" ? (
                <Text style={styles.bodyMuted}>Available once the job is awarded.</Text>
              ) : (
                <>
                  <Text style={styles.bodyMuted}>Propose a time (scaffold: uses your device timezone).</Text>

                  <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
                  <TextInput
                    value={proposeDate}
                    onChangeText={setProposeDate}
                    placeholder="2026-02-05"
                    placeholderTextColor="#94a3b8"
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />

                  <View style={styles.rowGap}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>Start (HH:MM)</Text>
                      <TextInput
                        value={proposeStartTime}
                        onChangeText={setProposeStartTime}
                        placeholder="09:00"
                        placeholderTextColor="#94a3b8"
                        style={styles.input}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>Duration (mins)</Text>
                      <TextInput
                        value={proposeDurationMins}
                        onChangeText={setProposeDurationMins}
                        placeholder="60"
                        placeholderTextColor="#94a3b8"
                        style={styles.input}
                        keyboardType="number-pad"
                      />
                    </View>
                  </View>

                  <Pressable
                    style={[styles.primaryBtn, appointmentsActing?.action === "propose" && styles.btnDisabled]}
                    onPress={onProposeAppointment}
                    disabled={appointmentsActing?.action === "propose"}
                  >
                    <Text style={styles.primaryText}>
                      {appointmentsActing?.action === "propose" ? "Proposing…" : "Propose Appointment"}
                    </Text>
                  </Pressable>
                </>
              )}

              {appointmentsError ? <Text style={styles.errorText}>{appointmentsError}</Text> : null}

              {appointmentsLoading ? (
                <View style={styles.inlineCenter}>
                  <ActivityIndicator />
                  <Text style={styles.bodyMuted}>Loading appointments…</Text>
                </View>
              ) : appointments.length === 0 ? (
                <Text style={styles.bodyMuted}>No appointments yet.</Text>
              ) : (
                <View style={{ gap: 10, marginTop: 10 }}>
                  {appointments.map((a) => {
                    const isActing = appointmentsActing?.id === a.id;
                    return (
                      <View key={String(a.id)} style={styles.apptRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.bodyStrong}>{a.status}</Text>
                          <Text style={styles.bodyMuted}>{formatLocalRange(a.startAt, a.endAt)}</Text>
                        </View>
                        {a.status !== "CANCELLED" ? (
                          <Pressable
                            style={[styles.dangerBtnSm, isActing && styles.btnDisabled]}
                            onPress={() => onCancelAppointment(a)}
                            disabled={isActing}
                          >
                            <Text style={styles.dangerTextSm}>Cancel</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

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

            {job.status === "DISPUTED" ? (
              <Text style={styles.bodyMuted}>A dispute has been opened for this job.</Text>
            ) : canOpenDispute ? (
              <Pressable style={styles.dangerBtn} onPress={goToOpenDispute}>
                <Text style={styles.dangerText}>Open Dispute</Text>
              </Pressable>
            ) : null}

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

            {!canCancel && !canComplete && !canConfirmComplete ? (
              <Text style={styles.bodyMuted}>No actions available for this status.</Text>
            ) : null}

            {canComplete ? (
              <Pressable
                style={[styles.primaryBtn, busyAction && styles.btnDisabled]}
                disabled={!!busyAction}
                onPress={doMarkComplete}
              >
                <Text style={styles.primaryText}>
                  {busyAction === "markComplete" ? "Requesting completion…" : "Mark Complete"}
                </Text>
              </Pressable>
            ) : null}

            {canConfirmComplete ? (
              <Pressable
                style={[
                  styles.primaryBtn,
                  busyAction && styles.btnDisabled,
                  canComplete ? { marginTop: 10 } : { marginTop: 0 },
                ]}
                disabled={!!busyAction}
                onPress={doConfirmComplete}
              >
                <Text style={styles.primaryText}>
                  {busyAction === "confirmComplete" ? "Confirming…" : "Confirm Completion"}
                </Text>
              </Pressable>
            ) : null}

            {canCancel ? (
              <Pressable
                style={[
                  styles.dangerBtn,
                  busyAction && styles.btnDisabled,
                  canComplete || canConfirmComplete ? { marginTop: 10 } : { marginTop: 0 },
                ]}
                disabled={!!busyAction}
                onPress={goToCancelJob}
              >
                <Text style={styles.dangerText}>
                  Cancel Job
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
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 6, fontSize: 14 },
  sectionLink: { color: "#38bdf8", fontWeight: "900" },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyStrong: { color: "#fff", fontSize: 16, fontWeight: "900" },
  bodyMuted: { color: "#94a3b8", fontSize: 13, lineHeight: 18 },
  metaSmall: { color: "#94a3b8", marginTop: 8, fontSize: 12 },

  label: { color: "#94a3b8", fontSize: 12, marginTop: 10, marginBottom: 6 },
  input: {
    backgroundColor: "#020617",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: "#e2e8f0",
  },
  rowGap: { flexDirection: "row", gap: 10, marginTop: 10 },
  inlineCenter: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
  errorText: { color: "#fca5a5", marginTop: 10 },

  apptRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#020617",
    borderWidth: 1,
    borderColor: "#1e293b",
    gap: 10,
  },

  dangerBtnSm: {
    backgroundColor: "#ef4444",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignItems: "center",
  },
  dangerTextSm: { color: "#0b1220", fontWeight: "900" },

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
