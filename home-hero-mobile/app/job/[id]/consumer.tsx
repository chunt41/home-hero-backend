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
import { api } from "../../../src/lib/apiClient";
import { JobTimeline } from "../../../src/components/JobTimeline";

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
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReasonCode?: string | null;
  cancellationReasonDetails?: string | null;
};

export default function ConsumerJobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
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
      const data = await api.get<JobDetail>(`/consumer/jobs/${jobId}`);
      setJob(data);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load job.");
      setJob(null);
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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>My Job</Text>
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
            <Text style={styles.sectionTitle}>Status</Text>
            <Text style={styles.body}>{job.status}</Text>
          </View>

          {(job.status === "OPEN" || job.status === "AWARDED" || job.status === "IN_PROGRESS") ? (
            <Pressable
              style={styles.dangerBtn}
              onPress={() => router.push(`/job/${jobId}/cancel`)}
            >
              <Text style={styles.dangerText}>Cancel Job</Text>
            </Pressable>
          ) : null}

          {(job.status === "COMPLETED" || job.status === "COMPLETED_PENDING_CONFIRMATION") ? (
            <Pressable
              style={styles.dangerBtn}
              onPress={() => router.push({ pathname: "/open-dispute", params: { jobId: String(job.id) } } as any)}
            >
              <Text style={styles.dangerText}>Open Dispute</Text>
            </Pressable>
          ) : null}

          <Pressable
            style={styles.primaryBtn}
            onPress={() => router.push(`/job/${jobId}/bids`)}
          >
            <Text style={styles.primaryText}>View Bids</Text>
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

  card: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
  },
  sectionTitle: {
    color: "#fff",
    fontWeight: "900",
    marginBottom: 6,
    fontSize: 14,
  },
  body: { color: "#e2e8f0", fontSize: 14 },

  primaryBtn: {
    marginTop: 20,
    backgroundColor: "#38bdf8",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#020617", fontWeight: "900" },

  dangerBtn: {
    marginTop: 12,
    backgroundColor: "#ef4444",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  dangerText: { color: "#0b1220", fontWeight: "900" },
});
