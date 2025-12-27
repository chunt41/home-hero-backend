// app/consumer/job/[id]/bids.tsx
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { api } from "../../../../src/lib/apiClient";

type ProviderSummary = {
  id: number;
  name: string | null;
  location: string | null;
  rating: number | null;
  reviewCount: number;
};

type CounterOffer = {
  id: number;
  minAmount: number | null;
  maxAmount: number | null;
  amount: number; // canonical
  message: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | string;
  createdAt: string;
  updatedAt?: string;
};

type BidItem = {
  id: number;
  amount: number;
  message: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | string;
  createdAt: string;
  provider: ProviderSummary;
  counter: CounterOffer | null;
};

type ConsumerJobDetail = {
  id: number;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | string;
  bidCount: number;
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

export default function ConsumerJobBidsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = useMemo(() => Number(id), [id]);

  const [job, setJob] = useState<ConsumerJobDetail | null>(null);
  const [items, setItems] = useState<BidItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actingBidId, setActingBidId] = useState<number | null>(null);

  // Avoid race conditions
  const requestIdRef = useRef(0);

  const fetchAll = useCallback(
    async (mode: "initial" | "refresh") => {
      const requestId = ++requestIdRef.current;

      if (!Number.isFinite(jobId)) {
        setError("Invalid job id.");
        setLoading(false);
        return;
      }

      if (mode === "initial") setLoading(true);
      if (mode === "refresh") setRefreshing(true);

      setError(null);

      try {
        // 1) job details (so we can disable UI when not OPEN)
        const jobData = await api.get<ConsumerJobDetail>(`/consumer/jobs/${jobId}`);
        // 2) bids list
        const bidsData = await api.get<BidItem[]>(`/jobs/${jobId}/bids`);

        if (requestId !== requestIdRef.current) return;

        setJob(jobData ?? null);
        setItems(Array.isArray(bidsData) ? bidsData : []);
      } catch (e: any) {
        if (requestId !== requestIdRef.current) return;
        setError(e?.message ?? "Failed to load bids.");
        setJob(null);
        setItems([]);
      } finally {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [jobId]
  );

  useFocusEffect(
    useCallback(() => {
      fetchAll("initial");
    }, [fetchAll])
  );

  const onRefresh = useCallback(() => fetchAll("refresh"), [fetchAll]);

  const jobStatus = job?.status ?? "—";
  const jobNotOpen = !!job && job.status !== "OPEN";
  const acceptedBid = useMemo(
    () => items.find((b) => b.status === "ACCEPTED") ?? null,
    [items]
  );

  const showLockBanner = useMemo(() => {
    if (!job) return false;
    // For consumer lifecycle: OPEN is interactive; everything else is locked.
    return job.status !== "OPEN";
  }, [job]);

  const lockBannerText = useMemo(() => {
    if (!job) return "";
    if (job.status === "IN_PROGRESS") return "Job is IN_PROGRESS — awarding & counter edits are locked.";
    if (job.status === "COMPLETED") return "Job is COMPLETED — bids are read-only.";
    if (job.status === "CANCELLED") return "Job is CANCELLED — bids are read-only.";
    return `Job is ${job.status} — bids are read-only.`;
  }, [job]);

  const onSendOrEditCounter = useCallback(
    (bidId: number) => {
      router.push(`/consumer/job/${jobId}/counter?bidId=${bidId}`);
    },
    [jobId]
  );

  const onOpenMessages = useCallback(() => {
    router.push(`/messages/${jobId}`);
  }, [jobId]);

  const onAcceptBid = useCallback(
    async (bidId: number) => {
      try {
        setActingBidId(bidId);
        setError(null);

        // awards + moves job status (your backend does: job -> IN_PROGRESS)
        await api.post(`/jobs/${jobId}/bids/${bidId}/accept`, {});

        // refresh first so UI is correct
        await fetchAll("initial");

        // then jump straight to chat thread
        // go back to the consumer job detail page
        router.push(`/consumer/job/${jobId}`);

      } catch (e: any) {
        setError(e?.message ?? "Failed to accept bid.");
      } finally {
        setActingBidId(null);
      }
    },
    [fetchAll, jobId]
  );

  const confirmAccept = useCallback(
    (bidId: number) => {
      if (jobNotOpen) return;

      Alert.alert(
        "Accept this bid?",
        "This will award the job to this provider and move the job to IN_PROGRESS.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Accept",
            style: "default",
            onPress: () => onAcceptBid(bidId),
          },
        ]
      );
    },
    [jobNotOpen, onAcceptBid]
  );

  const renderItem = ({ item }: { item: BidItem }) => {
    const counter = item.counter;

    const isAccepted = item.status === "ACCEPTED";
    const isAwarded = !!acceptedBid && acceptedBid.id === item.id;

    const counterPending = !!counter && counter.status === "PENDING";

    // ✅ Rules:
    // - If job not OPEN => lock everything
    // - If bid accepted => lock counter editing + accept
    // - If counter pending => disable accept (force counter decision)
    const acceptDisabled =
      actingBidId === item.id ||
      jobNotOpen ||
      isAccepted ||
      item.status !== "PENDING" ||
      counterPending;

    const counterLocked =
      jobNotOpen ||
      isAccepted ||
      actingBidId === item.id ||
      (acceptedBid && !isAwarded);

    const counterLabel =
      !counter
        ? "No counter"
        : counter.status === "PENDING"
        ? "Counter pending"
        : counter.status === "ACCEPTED"
        ? "Counter accepted"
        : counter.status === "DECLINED"
        ? "Counter declined"
        : `Counter: ${counter.status}`;

    return (
      <View style={[styles.card, isAwarded && styles.cardAwarded]}>
        <View style={styles.cardTopRow}>
          <Text style={styles.title} numberOfLines={1}>
            {item.provider?.name ?? "Provider"}
          </Text>

          <View style={[styles.badge, isAwarded && styles.badgeAwarded]}>
            <Text style={styles.badgeText}>
              {isAwarded ? "AWARDED" : item.status}
            </Text>
          </View>
        </View>

        {!!item.provider?.location && (
          <Text style={styles.meta} numberOfLines={1}>
            📍 {item.provider.location}
          </Text>
        )}

        <Text style={styles.meta}>
          ⭐ {item.provider?.rating ?? "—"} ({item.provider?.reviewCount ?? 0})
        </Text>

        <Text style={styles.desc} numberOfLines={3}>
          {item.message?.trim() ? item.message : "No message provided."}
        </Text>

        <View style={styles.footerRow}>
          <Text style={styles.meta}>💰 {moneyRangeText(item.amount)}</Text>
          <Text style={styles.metaSmall}>{formatDate(item.createdAt)}</Text>
        </View>

        <View style={styles.counterBox}>
          <Text style={styles.sectionTitle}>Counter</Text>
          <Text style={styles.metaSmall}>{counterLabel}</Text>

          {counter ? (
            <>
              <Text style={styles.meta}>
                💬 {counter.message?.trim() ? counter.message : "(no message)"}
              </Text>
              <Text style={styles.meta}>
                💰 {moneyRangeText(counter.amount, counter.minAmount, counter.maxAmount)}
              </Text>
              <Text style={styles.metaSmall}>
                Updated: {formatDate(counter.updatedAt ?? counter.createdAt)}
              </Text>
            </>
          ) : (
            <Text style={styles.metaSmall}>You haven't sent a counter yet.</Text>
          )}
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            style={[styles.secondaryBtn, counterLocked && styles.btnDisabled]}
            onPress={() => onSendOrEditCounter(item.id)}
            disabled={counterLocked}
          >
            <Text style={styles.secondaryText}>
              {counter ? "Edit Counter" : "Send Counter"}
            </Text>
          </Pressable>

          {isAwarded || (job?.status === "IN_PROGRESS" && isAccepted) ? (
            <Pressable style={styles.primaryBtn} onPress={onOpenMessages}>
              <Text style={styles.primaryText}>Open Messages</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.primaryBtn, acceptDisabled && styles.btnDisabled]}
              onPress={() => confirmAccept(item.id)}
              disabled={acceptDisabled}
            >
              {actingBidId === item.id ? (
                <ActivityIndicator />
              ) : (
                <Text style={styles.primaryText}>
                  {jobNotOpen ? "Job Not Open" : isAccepted ? "Accepted" : "Accept Bid"}
                </Text>
              )}
            </Pressable>
          )}
        </View>

        {counterPending ? (
          <Text style={styles.hint}>
            A counter is pending. Resolve the counter flow before awarding.
          </Text>
        ) : null}

        {isAwarded && job?.status !== "OPEN" ? (
          <Text style={styles.hint}>
            Awarded and job is {job.status}. Use “Open Messages” to coordinate.
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            Bids
          </Text>
          {job ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              {job.title} • {jobStatus}
            </Text>
          ) : null}
        </View>

        <Pressable onPress={() => fetchAll("refresh")} style={styles.refreshBtn}>
          <Text style={styles.refreshText}>↻</Text>
        </Pressable>
      </View>

      {showLockBanner ? (
        <View style={styles.lockBanner}>
          <Text style={styles.lockBannerText}>{lockBannerText}</Text>
          {job?.status === "IN_PROGRESS" && acceptedBid ? (
            <Pressable style={styles.lockBannerBtn} onPress={onOpenMessages}>
              <Text style={styles.lockBannerBtnText}>Open Messages</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={() => fetchAll("initial")}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.loadingText}>Loading bids…</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(x) => String(x.id)}
          renderItem={renderItem}
          contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.listContainer}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No bids yet.</Text>
              <Text style={styles.emptySubText}>
                When providers bid on your job, they’ll appear here.
              </Text>
            </View>
          }
        />
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
    gap: 10,
  },
  backBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  backText: { color: "#38bdf8", fontWeight: "800" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "900" },
  headerSub: { color: "#94a3b8", marginTop: 2, fontSize: 12 },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#111827",
  },
  refreshText: { color: "#38bdf8", fontWeight: "900", fontSize: 18 },

  lockBanner: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#111827",
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  lockBannerText: { color: "#cbd5e1", fontSize: 12, lineHeight: 16 },
  lockBannerBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#38bdf8",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  lockBannerBtnText: { color: "#020617", fontWeight: "900" },

  listContainer: { padding: 16, paddingBottom: 24 },
  emptyContainer: { flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 16 },

  card: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f172a",
  },
  cardAwarded: {
    borderColor: "#38bdf8",
  },

  cardTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  title: { color: "#fff", fontSize: 16, fontWeight: "900", flex: 1 },
  badge: { backgroundColor: "#1e293b", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  badgeAwarded: { backgroundColor: "#0ea5e9" },
  badgeText: { color: "#cbd5e1", fontSize: 12, fontWeight: "800" },

  meta: { color: "#cbd5e1", marginTop: 6, fontSize: 13 },
  metaSmall: { color: "#94a3b8", marginTop: 6, fontSize: 12 },

  desc: { color: "#e2e8f0", marginTop: 8, fontSize: 14, lineHeight: 19 },

  footerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, gap: 10, alignItems: "center" },

  counterBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "#111827",
  },
  sectionTitle: { color: "#fff", fontWeight: "900", marginBottom: 2 },

  actionsRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  primaryBtn: { flex: 1, backgroundColor: "#38bdf8", padding: 14, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#020617", fontWeight: "900" },

  secondaryBtn: { flex: 1, backgroundColor: "#1e293b", padding: 14, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#e2e8f0", fontWeight: "900" },

  btnDisabled: { opacity: 0.5 },

  hint: { color: "#93c5fd", marginTop: 10, fontSize: 12 },

  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 16 },
  loadingText: { color: "#cbd5e1", marginTop: 10 },

  emptyText: { color: "#fff", fontSize: 18, fontWeight: "900" },
  emptySubText: { color: "#94a3b8", marginTop: 6, textAlign: "center" },

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
