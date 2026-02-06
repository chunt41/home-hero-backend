// app/job/[id]/bids.tsx  (Provider view of bids on a job -> "My Bid" + counter actions)
// NOTE: This screen expects provider routes already exist:
// - GET /provider/jobs/:jobId  -> { job, myBid }
// - POST /bids/:bidId/counter/accept
// - POST /bids/:bidId/counter/decline

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
  minAmount: number | null;
  maxAmount: number | null;
  amount: number;
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

type ProviderJobResponse = {
  job: JobDetail;
  myBid: MyBid | null;
};

function moneyRangeText(amount: number, min?: number | null, max?: number | null) {
  if (min != null && max != null) return `$${min}–$${max}`;
  return `$${amount}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function ProviderJobBidsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [data, setData] = useState<ProviderJobResponse | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (mode: "initial" | "refresh") => {
    if (!Number.isFinite(jobId)) {
      setError("Invalid job id.");
      setLoading(false);
      return;
    }

    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);

    setError(null);

    try {
      const resp = await api.get<ProviderJobResponse>(`/provider/jobs/${jobId}`);
      setData(resp);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load job bids.");
      setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [jobId]);

  useFocusEffect(
    useCallback(() => {
      fetchData("initial");
    }, [fetchData])
  );

  const onRefresh = useCallback(() => fetchData("refresh"), [fetchData]);

  const onAcceptCounter = useCallback(async () => {
    if (!data?.myBid?.id) return;
    try {
      setActing("accept");
      await api.post(`/bids/${data.myBid.id}/counter/accept`, {});
      await fetchData("initial");
    } catch (e: any) {
      setError(e?.message ?? "Failed to accept counter.");
    } finally {
      setActing(null);
    }
  }, [data?.myBid?.id, fetchData]);

  const onDeclineCounter = useCallback(async () => {
    if (!data?.myBid?.id) return;
    try {
      setActing("decline");
      await api.post(`/bids/${data.myBid.id}/counter/decline`, {});
      await fetchData("initial");
    } catch (e: any) {
      setError(e?.message ?? "Failed to decline counter.");
    } finally {
      setActing(null);
    }
  }, [data?.myBid?.id, fetchData]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          Bids
        </Text>

        <Pressable onPress={onRefresh} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>{refreshing ? "…" : "Refresh"}</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => fetchData("initial")}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : !data?.job ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Job not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Job</Text>
            <Text style={styles.title} numberOfLines={1}>{data.job.title}</Text>
            {data.job.location ? (
              <Text style={styles.meta} numberOfLines={1}>📍 {data.job.location}</Text>
            ) : null}
            <Text style={styles.meta}>Status: {data.job.status}</Text>
            <Text style={styles.metaSmall}>{formatDate(data.job.createdAt)}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>My Bid</Text>

            {!data.myBid ? (
              <>
                <Text style={styles.metaSmall}>You haven’t placed a bid yet.</Text>
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => router.push(`/job/${data.job.id}/bid`)}
                >
                  <Text style={styles.primaryText}>Place Bid</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.row}>
                  <Text style={styles.meta}>Bid ID: {data.myBid.id}</Text>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{data.myBid.status}</Text>
                  </View>
                </View>

                <Text style={styles.meta}>💰 {moneyRangeText(data.myBid.amount)}</Text>
                <Text style={styles.metaSmall}>{formatDate(data.myBid.createdAt)}</Text>

                <Text style={styles.desc}>
                  {data.myBid.message?.trim() ? data.myBid.message : "No message provided."}
                </Text>

                <View style={styles.actionsRow}>
                  <Pressable
                    style={styles.secondaryBtn}
                    onPress={() => router.push(`/job/${data.job.id}/bid`)}
                  >
                    <Text style={styles.secondaryText}>Update Bid</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>

          {data.myBid?.counter ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Counter Offer</Text>

              <View style={styles.row}>
                <Text style={styles.meta}>
                  💰{" "}
                  {moneyRangeText(
                    data.myBid.counter.amount,
                    data.myBid.counter.minAmount,
                    data.myBid.counter.maxAmount
                  )}
                </Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{data.myBid.counter.status}</Text>
                </View>
              </View>

              <Text style={styles.desc}>
                {data.myBid.counter.message?.trim()
                  ? data.myBid.counter.message
                  : "No message provided."}
              </Text>

              <Text style={styles.metaSmall}>
                Updated: {formatDate(data.myBid.counter.updatedAt ?? data.myBid.counter.createdAt)}
              </Text>

              {data.myBid.counter.status === "PENDING" ? (
                <View style={styles.actionsRow}>
                  <Pressable
                    style={[styles.primaryBtn, acting && styles.btnDisabled]}
                    onPress={onAcceptCounter}
                    disabled={!!acting}
                  >
                    {acting === "accept" ? (
                      <ActivityIndicator />
                    ) : (
                      <Text style={styles.primaryText}>Accept</Text>
                    )}
                  </Pressable>

                  <Pressable
                    style={[styles.secondaryBtn, acting && styles.btnDisabled]}
                    onPress={onDeclineCounter}
                    disabled={!!acting}
                  >
                    {acting === "decline" ? (
                      <ActivityIndicator />
                    ) : (
                      <Text style={styles.secondaryText}>Decline</Text>
                    )}
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.metaSmall}>This counter is {data.myBid.counter.status}.</Text>
              )}
            </View>
          ) : null}
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

  refreshBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  refreshText: { color: "#94a3b8", fontWeight: "800" },

  content: { padding: 16, paddingBottom: 26 },

  card: { backgroundColor: "#0f172a", borderRadius: 14, padding: 14, marginBottom: 12 },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 8, fontSize: 14 },

  title: { color: "#fff", fontSize: 18, fontWeight: "900" },

  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 8 },
  badge: { backgroundColor: "#1e293b", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  badgeText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },

  meta: { color: "#cbd5e1", marginTop: 6, fontSize: 13 },
  metaSmall: { color: "#94a3b8", marginTop: 6, fontSize: 12 },
  desc: { color: "#e2e8f0", marginTop: 10, fontSize: 14, lineHeight: 19 },

  actionsRow: { flexDirection: "row", gap: 10, marginTop: 12 },

  primaryBtn: { flex: 1, backgroundColor: "#38bdf8", padding: 14, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#020617", fontWeight: "900" },

  secondaryBtn: { flex: 1, backgroundColor: "#1e293b", padding: 14, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  btnDisabled: { opacity: 0.6 },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  loadingText: { color: "#cbd5e1", marginTop: 10 },
  emptyText: { color: "#fff", fontSize: 18, fontWeight: "900" },

  errorBox: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  errorText: { color: "#fca5a5", marginBottom: 10 },
  retryBtn: { alignSelf: "flex-start", backgroundColor: "#38bdf8", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  retryText: { color: "#020617", fontWeight: "900" },
});
