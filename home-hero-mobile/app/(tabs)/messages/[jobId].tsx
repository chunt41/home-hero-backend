// app/(tabs)/messages/[jobId].tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  ScrollView,
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
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";

type Sender = { id: number; name: string | null; role: string };

type Attachment = {
  id: number;
  url: string;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
};

type PendingAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type Msg = {
  id: number; // real id OR temp negative id for optimistic
  jobId: number;
  senderId: number;
  text: string;
  createdAt: string;
  sender: Sender;

  attachments?: Attachment[];

  // optimistic UI helpers
  _optimistic?: boolean;
  _status?: "SENDING" | "FAILED";
  _localAttachment?: PendingAttachment;
};

type PageInfo = { limit: number; nextCursor: number | null };
type MessagesResponse = { items: Msg[]; pageInfo: PageInfo };

function formatTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const rounded = i === 0 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function getMaxAttachmentBytes() {
  const raw = process.env.EXPO_PUBLIC_MAX_ATTACHMENT_MB;
  const mb = raw ? Number(raw) : 15;
  if (!Number.isFinite(mb) || mb <= 0) return 15 * 1024 * 1024;
  return Math.floor(mb * 1024 * 1024);
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
  const [myRole, setMyRole] = useState<string | null>(null);
  const tempIdRef = useRef(-1);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(
    null
  );

  const [error, setError] = useState<string | null>(null);

  const maxAttachmentBytes = useMemo(() => getMaxAttachmentBytes(), []);

  const pickAttachment = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission required",
          "Please allow access to your photo library to attach images or videos."
        );
        return;
      }

      const mediaTypes = (ImagePicker as any).MediaType
        ? [(ImagePicker as any).MediaType.Images, (ImagePicker as any).MediaType.Videos]
        : (ImagePicker as any).MediaTypeOptions?.All;

      const result = await ImagePicker.launchImageLibraryAsync({
        ...(mediaTypes ? { mediaTypes } : null),
        quality: 1,
      });

      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      const info = await FileSystem.getInfoAsync(asset.uri);
      const inferredSize = (info as any)?.size;
      const sizeBytes =
        typeof inferredSize === "number"
          ? inferredSize
          : typeof asset.fileSize === "number"
          ? asset.fileSize
          : 0;

      if (sizeBytes > maxAttachmentBytes) {
        Alert.alert(
          "File too large",
          `Max size is ${formatBytes(maxAttachmentBytes)}.`
        );
        return;
      }

      const name =
        asset.fileName ?? asset.uri.split("/").pop() ?? "attachment";

      const mimeType =
        asset.mimeType ??
        (asset.type === "video" ? "video/mp4" : "image/jpeg");

      setPendingAttachment({ uri: asset.uri, name, mimeType, sizeBytes });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("ExponentImagePicker")) {
        Alert.alert(
          "Not available",
          "This runtime is missing the image picker native module. If you're using Expo Go, update Expo Go and run `npx expo install expo-image-picker`, then restart with `npx expo start -c`. If you're using a development build, rebuild the dev client."
        );
        return;
      }
      Alert.alert("Error", msg || "Failed to pick attachment.");
    }
  }, [maxAttachmentBytes]);

  // -------------------------
  // 1) LOAD ME
  // -------------------------
  type MeResponse = { id: number; role: string };
  const loadMe = useCallback(async (): Promise<MeResponse | null> => {
    try {
      const me = await api.get<MeResponse>("/me");
      setMyUserId(me.id);
      setMyRole(me.role);
      return me;
    } catch {
      setMyUserId(null);
      setMyRole(null);
      return null;
    }
  }, []);

  // -------------------------
  // 1b) QUICK REPLIES (provider)
  // -------------------------
  type QuickReply = {
    id: number;
    title: string;
    body: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  };
  type QuickRepliesResponse = { items: QuickReply[] };

  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
  const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);

  const fetchQuickReplies = useCallback(async () => {
    setQuickRepliesLoading(true);
    setQuickRepliesError(null);
    try {
      const data = await api.get<QuickRepliesResponse>("/provider/quick-replies");
      setQuickReplies(data.items ?? []);
    } catch (e: any) {
      setQuickRepliesError(e?.message ?? "Failed to load quick replies");
      setQuickReplies([]);
    } finally {
      setQuickRepliesLoading(false);
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

  const fetchReadStates = useCallback(async (userIdOverride?: number) => {
    if (!Number.isFinite(numericJobId)) return;
    const uid = userIdOverride ?? myUserId;
    if (!uid) return;

    try {
      const data = await api.get<ReadStatesResponse>(
        `/jobs/${numericJobId}/messages/read-states`
      );

      const otherDates = (data.states ?? [])
        .filter((s) => s.userId !== uid)
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
        const me = await loadMe();
        await fetchReadStates(me?.id);
        if (me?.role === "PROVIDER") {
          await fetchQuickReplies();
        } else {
          setQuickReplies([]);
        }
        await fetchPage("initial");
        await markRead();
        startPolling();
      })();

      return () => {
        stopPolling();
      };
    }, [loadMe, fetchReadStates, fetchQuickReplies, fetchPage, markRead, startPolling, stopPolling])
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
    async (
      messageText: string,
      tempId?: number,
      attachmentOverride?: PendingAttachment | null
    ) => {
      const trimmed = messageText.trim();
      const attachmentToSend = attachmentOverride ?? pendingAttachment;
      const hasAttachment = !!attachmentToSend;
      if (!trimmed && !hasAttachment) return;

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
          attachments: [],
          _optimistic: true,
          _status: "SENDING",
          _localAttachment: attachmentToSend ?? undefined,
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
        if (hasAttachment && attachmentToSend) {
          const form = new FormData();
          if (trimmed) form.append("text", trimmed);
          form.append(
            "file",
            {
              uri: attachmentToSend.uri,
              name: attachmentToSend.name,
              type: attachmentToSend.mimeType,
            } as any
          );
          await api.upload(`/jobs/${numericJobId}/messages`, form);
        } else {
          await api.post(`/jobs/${numericJobId}/messages`, { text: trimmed });
        }

        setItems((prev) => prev.filter((m) => m.id !== optimisticId));
        if (attachmentOverride == null) setPendingAttachment(null);

        await fetchPage("refresh");
        await markRead();
        await fetchReadStates();
      } catch (e: any) {
        setItems((prev) =>
          prev.map((m) =>
            m.id === optimisticId ? { ...m, _status: "FAILED" as const } : m
          )
        );

        if (e?.status === 403 && e?.details?.code === "RESTRICTED") {
          const msg =
            e?.message ??
            "Your account is temporarily restricted from sending messages. Please try again later.";
          Alert.alert("Temporarily restricted", msg);
          setError(msg);
        } else {
          setError(e?.message ?? "Failed to send.");
        }
      }
    },
    [
      numericJobId,
      myUserId,
      pendingAttachment,
      fetchPage,
      markRead,
      fetchReadStates,
      scrollToBottom,
    ]
  );

  const onSend = useCallback(async () => {
    if (sending) return;
    const trimmed = text.trim();
    if (!trimmed && !pendingAttachment) return;

    setSending(true);
    setError(null);

    try {
      const attachmentToSend = pendingAttachment;
      setText("");
      setPendingAttachment(null);
      await sendMessage(trimmed, undefined, attachmentToSend);
    } finally {
      setSending(false);
    }
  }, [text, pendingAttachment, sending, sendMessage]);

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
            if (showRetry) sendMessage(msg.text ?? "", msg.id, msg._localAttachment);
          }}
          onLongPress={() => {
            if (msg._optimistic) return;
            if (isMine) return;

            Alert.alert(
              "Message options",
              "What would you like to do?",
              [
                {
                  text: "Report message",
                  style: "destructive",
                  onPress: () =>
                    router.push(`/report?type=MESSAGE&targetId=${msg.id}`),
                },
                {
                  text: "Report user",
                  style: "destructive",
                  onPress: () =>
                    router.push(
                      `/report?type=USER&targetId=${msg.senderId}`
                    ),
                },
                {
                  text: "Block user",
                  style: "destructive",
                  onPress: async () => {
                    try {
                      await api.post(`/users/${msg.senderId}/block`, {});
                      Alert.alert("Blocked", "User blocked.");
                    } catch (e: any) {
                      Alert.alert(
                        "Error",
                        e?.message ?? "Failed to block user."
                      );
                    }
                  },
                },
                { text: "Cancel", style: "cancel" },
              ]
            );
          }}
          style={bubbleStyle}
        >
          {!isMine ? (
            <Text style={styles.bubbleName} numberOfLines={1}>
              {msg.sender?.name ?? "User"}
            </Text>
          ) : null}

          {msg.text?.trim() ? (
            <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>
              {msg.text}
            </Text>
          ) : null}

          {(msg.attachments?.length ?? 0) > 0 ? (
            <View style={styles.attachmentsBox}>
              {msg.attachments!.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    if (!a.url) return;
                    Linking.openURL(a.url);
                  }}
                >
                  <Text
                    style={[
                      styles.attachmentLink,
                      isMine && styles.attachmentLinkMine,
                    ]}
                    numberOfLines={1}
                  >
                    {a.filename ?? "Attachment"}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {msg._optimistic && msg._localAttachment ? (
            <View style={styles.attachmentsBox}>
              <Text
                style={[
                  styles.attachmentPendingText,
                  isMine && styles.attachmentPendingTextMine,
                ]}
                numberOfLines={1}
              >
                {`Attachment: ${msg._localAttachment.name}`}
              </Text>
            </View>
          ) : null}

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
      <StatusBar style="light" backgroundColor="#020617" />
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
                {pendingAttachment ? (
                  <View style={styles.pendingRow}>
                    <Text style={styles.pendingText} numberOfLines={1}>
                      {`Attachment: ${pendingAttachment.name} (${formatBytes(
                        pendingAttachment.sizeBytes
                      )})`}
                    </Text>
                    <Pressable onPress={() => setPendingAttachment(null)}>
                      <Text style={styles.pendingRemove}>Remove</Text>
                    </Pressable>
                  </View>
                ) : null}

                {myRole === "PROVIDER" ? (
                  <View style={styles.quickRepliesWrap}>
                    <View style={styles.quickRepliesHeader}>
                      <Text style={styles.quickRepliesTitle}>Quick replies</Text>
                      <Pressable
                        onPress={() => router.push("/provider/quick-replies")}
                        hitSlop={8}
                      >
                        <Text style={styles.quickRepliesManage}>Manage</Text>
                      </Pressable>
                    </View>

                    {quickRepliesLoading ? (
                      <Text style={styles.quickRepliesMuted}>Loading…</Text>
                    ) : quickRepliesError ? (
                      <Text style={[styles.quickRepliesMuted, { color: "#f59e0b" }]}>
                        {quickRepliesError}
                      </Text>
                    ) : quickReplies.length === 0 ? (
                      <Text style={styles.quickRepliesMuted}>No quick replies yet.</Text>
                    ) : (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {quickReplies.map((qr) => (
                          <Pressable
                            key={qr.id}
                            style={styles.quickReplyChip}
                            onPress={() =>
                              setText((prev) =>
                                prev.trim().length
                                  ? `${prev.trim()}\n${qr.body}`
                                  : qr.body
                              )
                            }
                          >
                            <Text style={styles.quickReplyChipText}>{qr.title}</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                  </View>
                ) : null}

                <View style={styles.composerRow}>
                  <Pressable
                    style={[styles.attachBtn, sending && styles.btnDisabled]}
                    onPress={pickAttachment}
                    disabled={sending}
                  >
                    <Text style={styles.attachText}>Attach</Text>
                  </Pressable>

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
                      (!(text.trim() || pendingAttachment) || sending) &&
                        styles.btnDisabled,
                    ]}
                    onPress={onSend}
                    disabled={!(text.trim() || pendingAttachment) || sending}
                  >
                    <Text style={styles.sendText}>
                      {sending ? "Sending…" : "Send"}
                    </Text>
                  </Pressable>
                </View>
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
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    backgroundColor: "#020617",
  },
  quickRepliesWrap: {
    marginBottom: 10,
    backgroundColor: "#020617",
  },
  quickRepliesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  quickRepliesTitle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "900",
  },
  quickRepliesManage: {
    color: "#38bdf8",
    fontSize: 12,
    fontWeight: "900",
  },
  quickRepliesMuted: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  quickReplyChip: {
    backgroundColor: "#0f172a",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#1e293b",
    marginRight: 8,
  },
  quickReplyChipText: {
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: "900",
  },
  composerRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-end",
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    backgroundColor: "#0f172a",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
  },
  pendingText: { color: "#e2e8f0", fontWeight: "800", flex: 1 },
  pendingRemove: { color: "#38bdf8", fontWeight: "900" },
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
  attachBtn: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: "#e2e8f0", fontWeight: "900" },
  sendBtn: {
    backgroundColor: "#38bdf8",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#020617", fontWeight: "900" },

  attachmentsBox: {
    marginTop: 8,
    gap: 6,
  },
  attachmentLink: {
    color: "#38bdf8",
    textDecorationLine: "underline",
    fontWeight: "800",
  },
  attachmentLinkMine: {
    color: "#0f172a",
  },
  attachmentPendingText: {
    color: "#cbd5e1",
    fontWeight: "800",
  },
  attachmentPendingTextMine: {
    color: "#0f172a",
  },

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
