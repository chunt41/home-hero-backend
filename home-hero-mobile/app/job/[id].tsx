import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { api } from "../../src/lib/apiClient";
import { addEventToDeviceCalendar } from "../../src/lib/calendarIntegration";
import { useAuth } from "../../src/context/AuthContext";
import { JobTimeline } from "../../src/components/JobTimeline";

type JobDetail = {
  id: number;
  title: string;
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  status: string;
  location: string | null;
  createdAt: string;
  awardedAt?: string | null;
  completionPendingForUserId?: number | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReasonCode?: string | null;
  cancellationReasonDetails?: string | null;
};

type CounterOffer = {
  id: number;
  bidId?: number;
  minAmount: number | null;
  maxAmount: number | null;
  amount: number; // canonical
  message: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | string;
  createdAt: string;
  updatedAt?: string;
};

type MyBid = {
  id: number;
  amount: number;
  message: string | null;
  createdAt: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | string;
  counter?: CounterOffer | null;
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

function formatLocalRange(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} - ${endIso}`;
  }
  return `${start.toLocaleString()} – ${end.toLocaleTimeString()}`;
}

function formatMoneyRange(opts: {
  amount?: number | null;
  min?: number | null;
  max?: number | null;
}) {
  const { amount, min, max } = opts;
  if (min != null && max != null) return `$${min}–$${max}`;
  if (amount != null) return `$${amount}`;
  return "$?";
}

export default function ProviderJobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const { user } = useAuth();

  const [job, setJob] = useState<JobDetail | null>(null);
  const [myBid, setMyBid] = useState<MyBid | null>(null);

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState<string | null>(null);
  const [appointmentsActing, setAppointmentsActing] = useState<null | { id: number; action: "confirm" | "cancel" | "calendar" }>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [acting, setActing] = useState<"accept" | "decline" | null>(null);
  const [startActing, setStartActing] = useState(false);
  const [completionActing, setCompletionActing] = useState<"mark" | "confirm" | null>(null);

  const fetchJob = useCallback(async () => {
    if (!Number.isFinite(jobId)) {
      setError("Invalid job id.");
      setLoading(false);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const data = await api.get<{ job: JobDetail; myBid: MyBid | null }>(
        `/provider/jobs/${jobId}`
      );
      setJob(data.job);
      setMyBid(data.myBid);

      if (data?.myBid?.status === "ACCEPTED") {
        setAppointmentsLoading(true);
        setAppointmentsError(null);
        try {
          const appts = await api.get<{ items: Appointment[] }>(`/jobs/${jobId}/appointments`);
          setAppointments(appts.items ?? []);
        } catch (e: any) {
          setAppointmentsError(e?.message ?? "Failed to load appointments.");
          setAppointments([]);
        } finally {
          setAppointmentsLoading(false);
        }
      } else {
        setAppointments([]);
        setAppointmentsError(null);
        setAppointmentsLoading(false);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load job.");
      setJob(null);
      setMyBid(null);
      setAppointments([]);
      setAppointmentsError(null);
      setAppointmentsLoading(false);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useFocusEffect(
    useCallback(() => {
      fetchJob();
    }, [fetchJob])
  );

  const budgetText =
    job?.budgetMin != null || job?.budgetMax != null
      ? `${job?.budgetMin ?? "?"} - ${job?.budgetMax ?? "?"}`
      : "Budget not listed";

  // ✅ Bid is locked if:
  // - bid is not pending (accepted/declined), OR
  // - counter was accepted (meaning the negotiated price is final)
  const bidLocked = useMemo(() => {
    return (
      !!myBid &&
      (myBid.status !== "PENDING" || myBid.counter?.status === "ACCEPTED")
    );
  }, [myBid]);

  // ✅ Step 3 integration:
  // Enable messaging when:
  // - provider's bid has been accepted (awarded), OR
  // - job is not OPEN (IN_PROGRESS/COMPLETED/etc)
  // (Either condition indicates an active relationship worth messaging.)
  const canMessage = useMemo(() => {
    if (!job) return false;
    if (myBid?.status === "ACCEPTED") return true;
    return job.status !== "OPEN";
  }, [job, myBid?.status]);

  const canOpenDispute = useMemo(() => {
    if (!job) return false;
    if (
      job.status !== "IN_PROGRESS" &&
      job.status !== "COMPLETED" &&
      job.status !== "COMPLETED_PENDING_CONFIRMATION"
    ) {
      return false;
    }
    return myBid?.status === "ACCEPTED";
  }, [job, myBid?.status]);

  const canStartJob = useMemo(() => {
    if (!job) return false;
    if (job.status !== "AWARDED") return false;
    return myBid?.status === "ACCEPTED";
  }, [job, myBid?.status]);

  const canMarkComplete = useMemo(() => {
    if (!job) return false;
    if (job.status !== "IN_PROGRESS") return false;
    return myBid?.status === "ACCEPTED";
  }, [job, myBid?.status]);

  const canConfirmComplete = useMemo(() => {
    if (!job) return false;
    if (job.status !== "COMPLETED_PENDING_CONFIRMATION") return false;
    if (!user?.id) return false;
    if (job.completionPendingForUserId !== user.id) return false;
    return myBid?.status === "ACCEPTED";
  }, [job, myBid?.status, user?.id]);

  const goToLeaveReview = useCallback(() => {
    if (!Number.isFinite(jobId)) return;
    router.push(`/leave-review?jobId=${jobId}`);
  }, [jobId]);

  const onStartJob = useCallback(() => {
    if (!job) return;

    Alert.alert(
      "Start job?",
      "This marks the job IN_PROGRESS.",
      [
        { text: "Not yet", style: "cancel" },
        {
          text: "Start",
          onPress: async () => {
            try {
              setStartActing(true);
              await api.post(`/jobs/${job.id}/start`, {});
              await fetchJob();
              Alert.alert("Started", "Job is now IN_PROGRESS.");
            } catch (e: any) {
              Alert.alert("Error", e?.message ?? "Could not start job.");
            } finally {
              setStartActing(false);
            }
          },
        },
      ]
    );
  }, [job, fetchJob]);

  const onMarkComplete = useCallback(() => {
    if (!job) return;
    Alert.alert(
      "Mark complete?",
      "This requests completion confirmation from the other participant.",
      [
        { text: "Not yet", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            try {
              setCompletionActing("mark");
              await api.post(`/jobs/${job.id}/mark-complete`, {});
              await fetchJob();
              Alert.alert(
                "Requested",
                "Waiting for the other participant to confirm completion."
              );
            } catch (e: any) {
              Alert.alert("Error", e?.message ?? "Could not request completion.");
            } finally {
              setCompletionActing(null);
            }
          },
        },
      ]
    );
  }, [job, fetchJob]);

  const onConfirmComplete = useCallback(() => {
    if (!job) return;
    Alert.alert("Confirm completion?", "Confirm that the work is finished.", [
      { text: "Not yet", style: "cancel" },
      {
        text: "Yes",
        onPress: async () => {
          try {
            setCompletionActing("confirm");
            await api.post(`/jobs/${job.id}/confirm-complete`, {});
            await fetchJob();
            Alert.alert("Completed", "Job has been marked completed.");
          } catch (e: any) {
            Alert.alert("Error", e?.message ?? "Could not confirm completion.");
          } finally {
            setCompletionActing(null);
          }
        },
      },
    ]);
  }, [job, fetchJob]);

  const onAcceptCounter = useCallback(async () => {
    if (!myBid?.id) return;
    setActing("accept");
    setError(null);

    try {
      await api.post(`/bids/${myBid.id}/counter/accept`, {});
      await fetchJob();
    } catch (e: any) {
      setError(e?.message ?? "Failed to accept counter.");
    } finally {
      setActing(null);
    }
  }, [myBid?.id, fetchJob]);

  const onDeclineCounter = useCallback(async () => {
    if (!myBid?.id) return;
    setActing("decline");
    setError(null);

    try {
      await api.post(`/bids/${myBid.id}/counter/decline`, {});
      await fetchJob();
    } catch (e: any) {
      setError(e?.message ?? "Failed to decline counter.");
    } finally {
      setActing(null);
    }
  }, [myBid?.id, fetchJob]);

  const editBidDisabled = bidLocked || acting !== null;

  const onRefreshAppointments = useCallback(async () => {
    if (!Number.isFinite(jobId)) return;
    if (myBid?.status !== "ACCEPTED") return;

    setAppointmentsLoading(true);
    setAppointmentsError(null);
    try {
      const appts = await api.get<{ items: Appointment[] }>(`/jobs/${jobId}/appointments`);
      setAppointments(appts.items ?? []);
    } catch (e: any) {
      setAppointmentsError(e?.message ?? "Failed to load appointments.");
    } finally {
      setAppointmentsLoading(false);
    }
  }, [jobId, myBid?.status]);

  const onConfirmAppointment = useCallback(
    async (appt: Appointment) => {
      setAppointmentsActing({ id: appt.id, action: "confirm" });
      try {
        await api.post(`/appointments/${appt.id}/confirm`, {});
        await onRefreshAppointments();
      } catch (e: any) {
        Alert.alert("Confirm failed", e?.message ?? "Could not confirm appointment");
      } finally {
        setAppointmentsActing(null);
      }
    },
    [onRefreshAppointments]
  );

  const onCancelAppointment = useCallback(
    async (appt: Appointment) => {
      Alert.alert("Cancel appointment?", "This will mark the appointment as cancelled.", [
        { text: "No", style: "cancel" },
        {
          text: "Yes, cancel",
          style: "destructive",
          onPress: async () => {
            setAppointmentsActing({ id: appt.id, action: "cancel" });
            try {
              await api.post(`/appointments/${appt.id}/cancel`, {});
              await onRefreshAppointments();
            } catch (e: any) {
              Alert.alert("Cancel failed", e?.message ?? "Could not cancel appointment");
            } finally {
              setAppointmentsActing(null);
            }
          },
        },
      ]);
    },
    [onRefreshAppointments]
  );

  const onAddToCalendar = useCallback(
    async (appt: Appointment) => {
      if (!job) return;
      if (appt.status !== "CONFIRMED") {
        Alert.alert("Not confirmed", "Only confirmed appointments can be added to your calendar.");
        return;
      }

      setAppointmentsActing({ id: appt.id, action: "calendar" });
      try {
        const { eventId } = await addEventToDeviceCalendar({
          title: `HomeHero: ${job.title}`,
          startDate: new Date(appt.startAt),
          endDate: new Date(appt.endAt),
          notes: `Job #${job.id}`,
          location: job.location ?? undefined,
        });

        try {
          await api.post(`/appointments/${appt.id}/calendar-event`, { eventId });
        } catch {
          // Best-effort only: if backend hasn't rolled out persistence yet, still succeed locally.
        }

        Alert.alert("Added", "Event added to your calendar.");
      } catch (e: any) {
        Alert.alert("Calendar", e?.message ?? "Calendar integration not available.");
      } finally {
        setAppointmentsActing(null);
      }
    },
    [job]
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          Job Details
        </Text>

        <View style={{ width: 60 }} />
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

          <View style={styles.row}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{job.status}</Text>
            </View>

            {job.location ? (
              <Text style={styles.meta} numberOfLines={1}>
                📍 {job.location}
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Description</Text>
            <Text style={styles.body}>
              {job.description ?? "No description provided."}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Budget</Text>
            <Text style={styles.body}>💰 {budgetText}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>My Bid</Text>

            {myBid ? (
              <>
                <Text style={styles.body}>Amount: ${myBid.amount}</Text>
                <Text style={styles.body}>Status: {myBid.status}</Text>
                <Text style={styles.body}>
                  Note: {myBid.message?.trim() ? myBid.message : "(no note)"}
                </Text>

                {bidLocked ? (
                  <Text style={styles.hint}>
                    This bid is locked and can’t be edited.
                  </Text>
                ) : null}
              </>
            ) : (
              <Text style={styles.body}>You haven’t bid on this job yet.</Text>
            )}
          </View>

          {myBid?.counter ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Counter Offer</Text>

              <Text style={styles.body}>
                Offer:{" "}
                {formatMoneyRange({
                  amount: myBid.counter.amount,
                  min: myBid.counter.minAmount,
                  max: myBid.counter.maxAmount,
                })}
              </Text>

              <Text style={styles.body}>Status: {myBid.counter.status}</Text>

              <Text style={styles.body}>
                Note:{" "}
                {myBid.counter.message?.trim()
                  ? myBid.counter.message
                  : "(no note)"}
              </Text>

              {myBid.counter.status === "PENDING" ? (
                <View style={styles.actionsRow}>
                  <Pressable
                    style={[
                      styles.primaryBtn,
                      acting !== null && styles.btnDisabled,
                    ]}
                    onPress={onAcceptCounter}
                    disabled={acting !== null}
                  >
                    <Text style={styles.primaryText}>
                      {acting === "accept" ? "Accepting…" : "Accept"}
                    </Text>
                  </Pressable>

                  <Pressable
                    style={[
                      styles.secondaryBtn,
                      acting !== null && styles.btnDisabled,
                    ]}
                    onPress={onDeclineCounter}
                    disabled={acting !== null}
                  >
                    <Text style={styles.secondaryText}>
                      {acting === "decline" ? "Declining…" : "Decline"}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {myBid.counter.status === "DECLINED" ? (
                <Text style={styles.hint}>
                  You declined the counter. Your bid remains pending unless the
                  consumer accepts/declines it.
                </Text>
              ) : null}

              {myBid.counter.status === "ACCEPTED" ? (
                <Text style={styles.hint}>
                  You accepted the counter. Your bid is now locked.
                </Text>
              ) : null}
            </View>
          ) : null}

          {myBid?.status === "ACCEPTED" && (job.status === "AWARDED" || job.status === "IN_PROGRESS") ? (
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.sectionTitle}>Scheduling</Text>
                <Pressable onPress={onRefreshAppointments} disabled={appointmentsLoading}>
                  <Text style={styles.linkText}>{appointmentsLoading ? "…" : "Refresh"}</Text>
                </Pressable>
              </View>

              {appointmentsError ? <Text style={styles.errorInline}>{appointmentsError}</Text> : null}

              {appointmentsLoading ? (
                <View style={styles.inlineCenter}>
                  <ActivityIndicator />
                  <Text style={styles.muted}>Loading appointments…</Text>
                </View>
              ) : appointments.length === 0 ? (
                <Text style={styles.body}>No appointments proposed yet.</Text>
              ) : (
                <View style={{ gap: 10 }}>
                  {appointments.map((a) => {
                    const isActing = appointmentsActing?.id === a.id;
                    return (
                      <View key={String(a.id)} style={styles.apptRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.bodyStrong}>{a.status}</Text>
                          <Text style={styles.bodySmall}>{formatLocalRange(a.startAt, a.endAt)}</Text>
                        </View>

                        {a.status === "PROPOSED" ? (
                          <View style={{ flexDirection: "row", gap: 8 }}>
                            <Pressable
                              style={[styles.primaryBtnSm, isActing && styles.btnDisabled]}
                              onPress={() => onConfirmAppointment(a)}
                              disabled={isActing}
                            >
                              <Text style={styles.primaryTextSm}>{isActing ? "…" : "Confirm"}</Text>
                            </Pressable>
                            <Pressable
                              style={[styles.secondaryBtnSm, isActing && styles.btnDisabled]}
                              onPress={() => onCancelAppointment(a)}
                              disabled={isActing}
                            >
                              <Text style={styles.secondaryTextSm}>Cancel</Text>
                            </Pressable>
                          </View>
                        ) : a.status === "CONFIRMED" ? (
                          <Pressable
                            style={[styles.secondaryBtnSm, isActing && styles.btnDisabled]}
                            onPress={() => onAddToCalendar(a)}
                            disabled={isActing}
                          >
                            <Text style={styles.secondaryTextSm}>Add to calendar</Text>
                          </Pressable>
                        ) : (
                          <Pressable
                            style={[styles.secondaryBtnSm, isActing && styles.btnDisabled]}
                            onPress={() => onCancelAppointment(a)}
                            disabled={isActing}
                          >
                            <Text style={styles.secondaryTextSm}>Cancel</Text>
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          {(canStartJob || canMarkComplete || canConfirmComplete || (job.status === "COMPLETED" && myBid?.status === "ACCEPTED")) ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Completion</Text>

              {canStartJob ? (
                <Pressable
                  style={[styles.primaryBtn, (startActing || completionActing) && styles.btnDisabled]}
                  disabled={!!startActing || !!completionActing}
                  onPress={onStartJob}
                >
                  <Text style={styles.primaryText}>{startActing ? "Starting…" : "Start Job"}</Text>
                </Pressable>
              ) : null}

              {canMarkComplete ? (
                <Pressable
                  style={[styles.primaryBtn, completionActing && styles.btnDisabled]}
                  disabled={!!completionActing}
                  onPress={onMarkComplete}
                >
                  <Text style={styles.primaryText}>
                    {completionActing === "mark" ? "Requesting…" : "Mark Complete"}
                  </Text>
                </Pressable>
              ) : null}

              {canConfirmComplete ? (
                <Pressable
                  style={[
                    styles.primaryBtn,
                    completionActing && styles.btnDisabled,
                    canMarkComplete || canStartJob ? { marginTop: 10 } : null,
                  ]}
                  disabled={!!completionActing}
                  onPress={onConfirmComplete}
                >
                  <Text style={styles.primaryText}>
                    {completionActing === "confirm" ? "Confirming…" : "Confirm Completion"}
                  </Text>
                </Pressable>
              ) : null}

              {job.status === "COMPLETED" && myBid?.status === "ACCEPTED" ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={styles.bodySmall}>Job completed — you can leave or update a review.</Text>
                  <Pressable style={[styles.secondaryBtn, { marginTop: 10 }]} onPress={goToLeaveReview}>
                    <Text style={styles.secondaryText}>Leave Review</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Safety</Text>

            {canOpenDispute ? (
              <Pressable
                style={styles.dangerBtn}
                onPress={() => router.push({ pathname: "/open-dispute", params: { jobId: String(job.id) } } as any)}
              >
                <Text style={styles.dangerText}>Open Dispute</Text>
              </Pressable>
            ) : null}

            <Pressable
              style={styles.dangerBtn}
              onPress={() => router.push(`/report?type=JOB&targetId=${job.id}`)}
            >
              <Text style={styles.dangerText}>Report Job</Text>
            </Pressable>

            {(job.status === "AWARDED" || job.status === "IN_PROGRESS") && myBid?.status === "ACCEPTED" ? (
              <Pressable
                style={styles.dangerBtn}
                onPress={() => router.push(`/job/${job.id}/cancel`)}
              >
                <Text style={styles.dangerText}>Cancel Job</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.actionsRow}>
            <Pressable
              style={[styles.primaryBtn, editBidDisabled && styles.btnDisabled]}
              disabled={editBidDisabled}
              onPress={() => router.push(`/job/${job.id}/bid`)}
            >
              <Text style={styles.primaryText}>
                {bidLocked ? "Bid Locked" : myBid ? "Update Bid" : "Place Bid"}
              </Text>
            </Pressable>

            {/* ✅ Step 3: Message button */}
            <Pressable
              style={[styles.secondaryBtn, !canMessage && styles.btnDisabled]}
              disabled={!canMessage}
              onPress={() => router.push(`/messages/${job.id}`)}
            >
              <Text style={styles.secondaryText}>💬 Message</Text>
            </Pressable>
          </View>
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

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  muted: { color: "#cbd5e1", marginTop: 10 },
  error: { color: "#fca5a5", textAlign: "center", marginBottom: 12 },

  retryBtn: {
    backgroundColor: "#38bdf8",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "900" },

  content: { padding: 16, paddingBottom: 26 },
  title: { color: "#fff", fontSize: 22, fontWeight: "900", marginBottom: 10 },

  row: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  badge: { backgroundColor: "#1e293b", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  badgeText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },
  meta: { color: "#cbd5e1", flex: 1 },

  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginTop: 12 },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 6, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },
  bodyStrong: { color: "#e2e8f0", fontSize: 14, fontWeight: "900" },
  bodySmall: { color: "#cbd5e1", fontSize: 12, marginTop: 2 },

  inlineCenter: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  errorInline: { color: "#fca5a5", marginBottom: 8 },
  linkText: { color: "#38bdf8", fontWeight: "900" },

  apptRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#1e293b",
    gap: 10,
  },

  primaryBtnSm: { backgroundColor: "#38bdf8", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  primaryTextSm: { color: "#020617", fontWeight: "900" },

  secondaryBtnSm: { backgroundColor: "#1e293b", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  secondaryTextSm: { color: "#e2e8f0", fontWeight: "900" },

  actionsRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  primaryBtn: { flex: 1, backgroundColor: "#38bdf8", padding: 14, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#020617", fontWeight: "900" },

  secondaryBtn: { flex: 1, backgroundColor: "#1e293b", padding: 14, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },

  hint: { color: "#93c5fd", marginTop: 10, fontSize: 12 },

  dangerBtn: {
    backgroundColor: "#ef4444",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 10,
  },
  dangerText: { color: "#0b1220", fontWeight: "900" },
});
