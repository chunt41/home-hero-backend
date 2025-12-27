// app/(tabs)/messages/[jobId].tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useFocusEffect } from "expo-router";
import { api } from "../../../src/lib/apiClient";

type Sender = { id: number; name: string | null; role: string };

type Msg = {
  id: number; // real id OR temp negative id for optimistic
  jobId: number;
  senderId: number;
  text: string;
  createdAt: string;
  sender: Sender;

  // optimistic UI helpers
  _optimistic?: boolean;
  _status?: "SENDING" | "FAILED";
};

type PageInfo = { limit: number; nextCursor: number | null };
type MessagesResponse = { items: Msg[]; pageInfo: PageInfo };

function formatTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ----------
// DATE SEPARATOR HELPERS
// ----------
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const today = startOfDay(new Date());
  const thatDay = startOfDay(d);

  const diffMs = today.getTime() - thatDay.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";

  // ex: "Mon, Dec 21"
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// FlatList rows: either a date separator or a message bubble
type Row =
  | { kind: "date"; key: string; label: string }
  | { kind: "msg"; key: string; msg: Msg };

export default function JobMessagesThreadScreen() {
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const numericJobId = useMemo(() => Number(jobId), [jobId]);

  const [myUserId, setMyUserId] = useState<number | null>(null);
  const tempIdRef = useRef(-1);

  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const listRef = useRef<FlatList<Row>>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);

  const scrollToBottom = useCallback((animated: boolean = true) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  const [items, setItems] = useState<Msg[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // -------------------------
  // 1) LOAD ME
  // -------------------------
  type MeResponse = { id: number };
  const loadMe = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>("/me");
      setMyUserId(me.id);
    } catch {
      setMyUserId(null);
    }
  }, []);

  // -------------------------
  // 2) KEYBOARD HEIGHT (Android spacer)
  // -------------------------
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => {
      const h = e?.endCoordinates?.height ?? 0;
      setKeyboardHeight(h);
    });

    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // -------------------------
  // 3) SEEN INDICATOR
  // -------------------------
  type ReadStatesResponse = { states: { userId: number; lastReadAt: string }[] };
  const [othersLastReadAt, setOthersLastReadAt] = useState<Date | null>(null);

  const fetchReadStates = useCallback(async () => {
    if (!Number.isFinite(numericJobId)) return;
    if (!myUserId) return;

    try {
      const data = await api.get<ReadStatesResponse>(
        `/jobs/${numericJobId}/messages/read-states`
      );

      const otherDates = (data.states ?? [])
        .filter((s) => s.userId !== myUserId)
        .map((s) => new Date(s.lastReadAt))
        .filter((d) => !Number.isNaN(d.getTime()));

      if (otherDates.length === 0) {
        setOthersLastReadAt(null);
        return;
      }

      otherDates.sort((a, b) => b.getTime() - a.getTime());
      setOthersLastReadAt(otherDates[0]);
    } catch {
      // ignore
    }
  }, [numericJobId, myUserId]);

  const lastMyDeliveredMessageId = useMemo(() => {
    if (!myUserId) return null;

    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m.senderId === myUserId && !m._optimistic) return m.id;
    }
    return null;
  }, [items, myUserId]);

  // -------------------------
  // 4) DATE SEPARATOR ROWS (NEW)
  // -------------------------
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    let lastDay: Date | null = null;

    // items should already be sorted asc; but we’ll be safe:
    const sorted = [...items].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const m of sorted) {
      const d = new Date(m.createdAt);
      if (Number.isNaN(d.getTime())) {
        // if date is invalid, just treat as message (no separator)
        out.push({ kind: "msg", key: `m:${m.id}`, msg: m });
        continue;
      }

      if (!lastDay || !isSameDay(d, lastDay)) {
        const label = formatDateLabel(m.createdAt);
        const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        out.push({ kind: "date", key: `d:${dayKey}`, label });
        lastDay = d;
      }

      out.push({ kind: "msg", key: `m:${m.id}`, msg: m });
    }

    return out;
  }, [items]);

  // -------------------------
  // 5) FETCH MESSAGES
  // -------------------------
  const requestIdRef = useRef(0);

  // Track what kind of fetch updated items last
  const lastUpdateModeRef = useRef<"initial" | "refresh" | "older" | null>(null);

  // Track the bottom message "signature" so we only auto-scroll on real new messages
  const prevBottomSigRef = useRef<string | null>(null);

  // Optional: ensure initial load scrolls once
  const didInitialScrollRef = useRef(false);
  // If I just sent a message, force one scroll even if I'm not near bottom
  const forceScrollNextUpdateRef = useRef(false);

  // Build a signature for the last (bottom) message currently displayed
  const bottomSig = useMemo(() => {
    if (items.length === 0) return null;
    // items is already sorted asc in your setItems logic, but be safe:
    const sorted = [...items].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const last = sorted[sorted.length - 1];
    if (!last) return null;

    // Include id + createdAt + optimistic status so signature changes appropriately
    return `${last.id}|${last.createdAt}|${last._optimistic ? last._status ?? "" : "REAL"}`;
  }, [items]);

  const fetchPage = useCallback(
    async (mode: "initial" | "refresh" | "older") => {
      const requestId = ++requestIdRef.current;

      lastUpdateModeRef.current = mode;

      if (!Number.isFinite(numericJobId)) {
        setError("Invalid job id.");
        setLoading(false);
        return;
      }

      if (mode === "initial") setLoading(true);
      if (mode === "refresh") setRefreshing(true);
      if (mode === "older") setLoadingOlder(true);

      setError(null);

      try {
        const cursor = mode === "older" ? nextCursor : null;

        const qs = cursor
          ? `?limit=30&cursor=${encodeURIComponent(String(cursor))}`
          : `?limit=30`;

        const data = await api.get<MessagesResponse>(
          `/jobs/${numericJobId}/messages${qs}`
        );

        if (requestId !== requestIdRef.current) return;

        setNextCursor(data.pageInfo?.nextCursor ?? null);

        if (mode === "older") {
          setItems((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            const incoming = (data.items ?? []).filter(
              (m: Msg) => !seen.has(m.id)
            );
            return [...incoming, ...prev];
          });
        } else {
          setItems((prev) => {
            const optimistic = prev.filter((m) => m._optimistic);
            return [...(data.items ?? []), ...optimistic].sort(
              (a, b) =>
                new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            );
          });
        }

        await fetchReadStates();
      } catch (e: any) {
        if (requestId !== requestIdRef.current) return;
        setError(
          e?.response?.data?.error ?? e?.message ?? "Failed to load messages."
        );
      } finally {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        setRefreshing(false);
        setLoadingOlder(false);
      }
    },
    [numericJobId, nextCursor, fetchReadStates]
  );

  // -------------------------
  // 6) POLLING
  // -------------------------
  const startPolling = useCallback(() => {
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      try {
        await fetchPage("refresh");
      } catch {
        // ignore
      }
    }, 5000);
  }, [fetchPage]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // -------------------------
  // 7) MARK READ
  // -------------------------
  const markRead = useCallback(async () => {
    if (!Number.isFinite(numericJobId)) return;
    try {
      await api.post(`/jobs/${numericJobId}/messages/read`, {});
    } catch {
      // ignore
    }
  }, [numericJobId]);

  // -------------------------
  // 8) FOCUS LIFECYCLE
  // -------------------------
  useFocusEffect(
    useCallback(() => {
      (async () => {
        await loadMe();
        await fetchReadStates();
        await fetchPage("initial");
        await markRead();
        startPolling();
      })();

      return () => {
        stopPolling();
      };
    }, [loadMe, fetchReadStates, fetchPage, markRead, startPolling, stopPolling])
  );

  // -------------------------
  // 9) AUTO-SCROLL (use rows length now)
  // -------------------------
  useEffect(() => {
    // If nothing loaded, reset tracking
    if (!bottomSig) {
        prevBottomSigRef.current = null;
        didInitialScrollRef.current = false;
        return;
    }

    // Initial load: scroll once to bottom (no animation looks cleaner)
    if (!didInitialScrollRef.current) {
        scrollToBottom(false);
        didInitialScrollRef.current = true;
        prevBottomSigRef.current = bottomSig;
        return;
    }

    // If we just loaded older messages, DO NOT yank user to bottom
    if (lastUpdateModeRef.current === "older") {
        prevBottomSigRef.current = bottomSig;
        return;
    }

    // For refresh/initial updates: only auto-scroll if user is already near bottom
    // For refresh/initial updates: auto-scroll only if:
    // - user is near bottom OR
    // - we explicitly forced it (ex: user just sent a message)
    const changed = prevBottomSigRef.current !== bottomSig;

    if (changed) {
    if (forceScrollNextUpdateRef.current) {
        scrollToBottom(true);
        forceScrollNextUpdateRef.current = false;
    } else if (isNearBottom) {
        scrollToBottom(true);
    }
    }

    prevBottomSigRef.current = bottomSig;
  }, [bottomSig, isNearBottom, scrollToBottom]);


  const onRefresh = useCallback(async () => {
    await fetchPage("refresh");
    await markRead();
    await fetchReadStates();
  }, [fetchPage, markRead, fetchReadStates]);

  const onLoadOlder = useCallback(() => {
    if (!nextCursor || loadingOlder || loading || refreshing) return;
    fetchPage("older");
  }, [nextCursor, loadingOlder, loading, refreshing, fetchPage]);

  // -------------------------
  // 10) SEND MESSAGE
  // -------------------------
  const sendMessage = useCallback(
    async (messageText: string, tempId?: number) => {
      const trimmed = messageText.trim();
      if (!trimmed) return;

      const optimisticId = tempId ?? tempIdRef.current--;
      const nowIso = new Date().toISOString();

      if (!tempId) {
        const optimisticMsg: Msg = {
          id: optimisticId,
          jobId: numericJobId,
          senderId: myUserId ?? -999999,
          text: trimmed,
          createdAt: nowIso,
          sender: {
            id: myUserId ?? -999999,
            name: "You",
            role: "",
          },
          _optimistic: true,
          _status: "SENDING",
        };

        setItems((prev) => [...prev, optimisticMsg]);
        forceScrollNextUpdateRef.current = true;
        scrollToBottom(true);

      } else {
        setItems((prev) =>
          prev.map((m) =>
            m.id === tempId ? { ...m, _status: "SENDING" as const } : m
          )
        );
      }

      try {
        await api.post(`/jobs/${numericJobId}/messages`, { text: trimmed });

        setItems((prev) => prev.filter((m) => m.id !== optimisticId));

        await fetchPage("refresh");
        await markRead();
        await fetchReadStates();
      } catch (e: any) {
        setItems((prev) =>
          prev.map((m) =>
            m.id === optimisticId ? { ...m, _status: "FAILED" as const } : m
          )
        );

        setError(e?.response?.data?.error ?? e?.message ?? "Failed to send.");
      }
    },
    [numericJobId, myUserId, fetchPage, markRead, fetchReadStates, scrollToBottom]
  );

  const onSend = useCallback(async () => {
    if (sending) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    setSending(true);
    setError(null);

    try {
      setText("");
      await sendMessage(trimmed);
    } finally {
      setSending(false);
    }
  }, [text, sending, sendMessage]);

  // -------------------------
  // 11) RENDER ROW (date OR message)
  // -------------------------
  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === "date") {
      return (
        <View style={styles.dateRow}>
          <View style={styles.datePill}>
            <Text style={styles.dateText}>{item.label}</Text>
          </View>
        </View>
      );
    }

    const msg = item.msg;
    const isMine = myUserId != null && msg.senderId === myUserId;

    const rowStyle = [
      styles.bubbleRow,
      isMine ? styles.bubbleRowRight : styles.bubbleRowLeft,
    ];

    const bubbleStyle = [
      styles.bubble,
      isMine ? styles.bubbleRight : styles.bubbleLeft,
    ];

    const meta = msg._optimistic
      ? msg._status === "SENDING"
        ? "Sending…"
        : msg._status === "FAILED"
        ? "Failed • Tap to retry"
        : ""
      : formatTime(msg.createdAt);

    const showRetry = msg._optimistic && msg._status === "FAILED";

    // Seen/Sent line for ONLY my most recent delivered message
    const showSeenLine =
      isMine && !msg._optimistic && msg.id === lastMyDeliveredMessageId;

    let seenLabel: string | null = null;
    if (showSeenLine) {
      const msgTime = new Date(msg.createdAt);
      const otherRead = othersLastReadAt;

      if (
        otherRead &&
        !Number.isNaN(msgTime.getTime()) &&
        otherRead.getTime() >= msgTime.getTime()
      ) {
        seenLabel = "Seen";
      } else {
        seenLabel = "Sent";
      }
    }

    return (
      <View style={rowStyle}>
        <Pressable
          disabled={!showRetry}
          onPress={() => {
            if (showRetry) sendMessage(msg.text, msg.id);
          }}
          style={bubbleStyle}
        >
          {!isMine ? (
            <Text style={styles.bubbleName} numberOfLines={1}>
              {msg.sender?.name ?? "User"}
            </Text>
          ) : null}

          <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>
            {msg.text}
          </Text>

          <Text style={[styles.bubbleMeta, isMine && styles.bubbleMetaMine]}>
            {meta}
          </Text>

          {seenLabel ? (
            <Text style={[styles.seenText, isMine && styles.seenTextMine]}>
              {seenLabel}
            </Text>
          ) : null}
        </Pressable>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 10 : 0}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} style={styles.backBtn}>
              <Text style={styles.backText}>← Back</Text>
            </Pressable>

            <Text style={styles.headerTitle} numberOfLines={1}>
              Messages • Job #{numericJobId}
            </Text>

            <View style={{ width: 60 }} />
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                style={styles.retryBtn}
                onPress={() => fetchPage("initial")}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator />
              <Text style={styles.muted}>Loading messages…</Text>
            </View>
          ) : (
            <>
              {nextCursor ? (
                <Pressable
                  style={[
                    styles.loadOlderBtn,
                    loadingOlder && styles.btnDisabled,
                  ]}
                  onPress={onLoadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? (
                    <ActivityIndicator />
                  ) : (
                    <Text style={styles.loadOlderText}>Load older messages</Text>
                  )}
                </Pressable>
              ) : null}

              <FlatList
                ref={listRef}
                style={{ flex: 1 }}
                data={rows}
                keyExtractor={(r) => r.key}
                renderItem={renderRow}
                contentContainerStyle={styles.list}
                refreshing={refreshing}
                onRefresh={onRefresh}
                keyboardShouldPersistTaps="handled"
                onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                  const { layoutMeasurement, contentOffset, contentSize } =
                    e.nativeEvent;
                  const distanceFromBottom =
                    contentSize.height -
                    (layoutMeasurement.height + contentOffset.y);

                  setIsNearBottom(distanceFromBottom < 120);
                }}
                scrollEventThrottle={16}
              />

              <View style={styles.composer}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder="Type a message…"
                  placeholderTextColor="#94a3b8"
                  style={styles.input}
                  multiline
                />
                <Pressable
                  style={[
                    styles.sendBtn,
                    (!text.trim() || sending) && styles.btnDisabled,
                  ]}
                  onPress={onSend}
                  disabled={!text.trim() || sending}
                >
                  <Text style={styles.sendText}>
                    {sending ? "Sending…" : "Send"}
                  </Text>
                </Pressable>
              </View>

              {Platform.OS === "android" && keyboardHeight > 0 ? (
                <View style={{ height: keyboardHeight }} />
              ) : null}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
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
  headerTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    flex: 1,
    marginLeft: 6,
  },

  list: { padding: 16, paddingBottom: 50 },

  // ✅ Date separator styles
  dateRow: {
    alignItems: "center",
    marginBottom: 10,
    marginTop: 6,
  },
  datePill: {
    backgroundColor: "#0f172a",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  dateText: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "800",
  },

  bubbleRow: {
    marginBottom: 10,
    flexDirection: "row",
  },
  bubbleRowLeft: {
    justifyContent: "flex-start",
  },
  bubbleRowRight: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "82%",
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bubbleLeft: {
    backgroundColor: "#0f172a",
    borderTopLeftRadius: 6,
  },
  bubbleRight: {
    backgroundColor: "#38bdf8",
    borderTopRightRadius: 6,
  },
  bubbleName: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 6,
  },
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
    color: "#e2e8f0",
  },
  bubbleTextMine: {
    color: "#020617",
  },
  bubbleMetaMine: {
    color: "#0f172a",
  },
  bubbleMeta: {
    marginTop: 8,
    fontSize: 11,
    color: "#94a3b8",
  },

  // Seen indicator styles
  seenText: {
    marginTop: 6,
    fontSize: 11,
    color: "#94a3b8",
  },
  seenTextMine: {
    color: "#0f172a",
  },

  composer: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    backgroundColor: "#020617",
  },
  input: {
    flex: 1,
    backgroundColor: "#0f172a",
    color: "#fff",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    maxHeight: 120,
  },
  sendBtn: {
    backgroundColor: "#38bdf8",
    borderRadius: 12,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#020617", fontWeight: "900" },

  loadOlderBtn: {
    marginTop: 12,
    marginHorizontal: 16,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#1e293b",
  },
  loadOlderText: { color: "#e2e8f0", fontWeight: "800" },

  btnDisabled: { opacity: 0.5 },

  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  muted: { color: "#cbd5e1", marginTop: 10 },

  errorBox: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    backgroundColor: "#1f2937",
    padding: 12,
    borderRadius: 12,
  },
  errorText: { color: "#fca5a5", marginBottom: 10 },
  retryBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#38bdf8",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  retryText: { color: "#020617", fontWeight: "900" },
});
