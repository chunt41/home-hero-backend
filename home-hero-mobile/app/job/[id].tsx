import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { api } from "../../src/lib/apiClient";

type JobDetail = {
  id: number;
  title: string;
  description: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  status: string;
  location: string | null;
  createdAt: string;
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

  const [job, setJob] = useState<JobDetail | null>(null);
  const [myBid, setMyBid] = useState<MyBid | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [acting, setActing] = useState<"accept" | "decline" | null>(null);

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
    } catch (e: any) {
      setError(e?.message ?? "Failed to load job.");
      setJob(null);
      setMyBid(null);
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

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Safety</Text>
            <Pressable
              style={styles.dangerBtn}
              onPress={() => router.push(`/report?type=JOB&targetId=${job.id}`)}
            >
              <Text style={styles.dangerText}>Report Job</Text>
            </Pressable>
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
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 6, fontSize: 14 },
  body: { color: "#e2e8f0", fontSize: 14, lineHeight: 20 },

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
