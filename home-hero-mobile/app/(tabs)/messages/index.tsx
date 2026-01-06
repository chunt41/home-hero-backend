import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, router } from "expo-router";
import { api } from "../../../src/lib/apiClient";
import { StatusBar } from "expo-status-bar";

type InboxThread = {
  job: {
    id: number;
    title: string;
    status: string;
    location: string | null;
    consumerId?: number;
  };
  lastMessage: {
    id: number;
    jobId: number;
    senderId: number;
    text: string;
    createdAt: string; // backend returns Date; axios gives string/ISO typically
    sender?: {
      id: number;
      name: string | null;
      email: string;
      role: string;
    };
  };
  unreadCount: number;
};

type ThreadsResponse = {
  threads: InboxThread[];
  nextCursor: string | null;
};

export default function MessagesIndexScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFirstPage = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.get<ThreadsResponse>("/me/inbox/threads?limit=20");
      setThreads(data.threads ?? []);
      setNextCursor(data.nextCursor ?? null);

    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? "Failed to load inbox.");
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.get<ThreadsResponse>("/me/inbox/threads?limit=20");
      setThreads(data.threads ?? []);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? "Failed to refresh inbox.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    if (loadingMore) return;

    setLoadingMore(true);
    try {
        const data = await api.get<ThreadsResponse>(
        `/me/inbox/threads?limit=20&cursor=${encodeURIComponent(nextCursor)}`
        );

        const newThreads = data.threads ?? [];
        setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.job.id));
        const merged = [...prev];
        for (const t of newThreads) {
            if (!seen.has(t.job.id)) merged.push(t);
        }
        return merged;
        });

        setNextCursor(data.nextCursor ?? null);
    } catch (e: any) {
        setError(e?.response?.data?.error ?? e?.message ?? "Failed to load more threads.");
    } finally {
        setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);


  useFocusEffect(
    useCallback(() => {
      fetchFirstPage();
    }, [fetchFirstPage])
  );

  const renderRow = ({ item }: { item: InboxThread }) => {
    const title = item.job.title ?? `Job #${item.job.id}`;
    const lastText = item.lastMessage?.text ?? "Open chat";
    const unread = item.unreadCount ?? 0;

    return (
      <Pressable
        onPress={() =>
          router.push({
            pathname: "/messages/[jobId]",
            params: { jobId: String(item.job.id) },
          })
        }
        style={{
          padding: 14,
          borderRadius: 12,
          backgroundColor: "#0f172a",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
            {title}
          </Text>
          <Text style={{ color: "#94a3b8", marginTop: 6 }} numberOfLines={1}>
            {lastText}
          </Text>
        </View>

        {unread > 0 ? (
          <View
            style={{
              minWidth: 28,
              paddingHorizontal: 8,
              height: 24,
              borderRadius: 12,
              backgroundColor: "#38bdf8",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "#020617", fontWeight: "700" }}>
              {unread > 99 ? "99+" : unread}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  if (loading) {
    return (
      <SafeAreaView
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#020617" }}
        edges={["top"]}
      >
        <StatusBar style="light" backgroundColor="#020617" />
        <ActivityIndicator />
        <Text style={{ marginTop: 8, color: "#e2e8f0" }}>Loading inbox…</Text>
      </SafeAreaView>
    );
  }

  if (error && threads.length === 0) {
    return (
      <SafeAreaView
        style={{ flex: 1, padding: 16, gap: 12, backgroundColor: "#020617" }}
        edges={["top"]}
      >
        <StatusBar style="light" backgroundColor="#020617" />
        <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
          Couldn’t load messages
        </Text>
        <Text style={{ color: "#cbd5e1" }}>{error}</Text>
        <Pressable
          onPress={fetchFirstPage}
          style={{ padding: 12, borderRadius: 10, backgroundColor: "#1e293b" }}
        >
          <Text style={{ color: "#e2e8f0", fontWeight: "800" }}>Retry</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 16, backgroundColor: "#020617" }} edges={["top"]}>
      <StatusBar style="light" backgroundColor="#020617" />
      <FlatList
        data={threads}
        keyExtractor={(t) => String(t.job.id)}
        renderItem={renderRow}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <Text style={{ color: "#94a3b8" }}>No conversations yet.</Text>
        }
        onEndReachedThreshold={0.4}
        onEndReached={loadMore}
        ListFooterComponent={
          loadingMore ? (
            <View style={{ paddingVertical: 16, alignItems: "center" }}>
              <ActivityIndicator />
              <Text style={{ marginTop: 8, color: "#94a3b8" }}>Loading more…</Text>
            </View>
          ) : nextCursor ? (
            <Pressable
              onPress={loadMore}
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 10,
                backgroundColor: "#1e293b",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#e2e8f0", fontWeight: "800" }}>
                Load more
              </Text>
            </Pressable>
          ) : (
            <View style={{ height: 12 }} />
          )
        }
      />
    </SafeAreaView>
  );
}
