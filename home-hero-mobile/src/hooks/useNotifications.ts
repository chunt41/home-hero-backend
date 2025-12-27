import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/apiClient";
import { emitNotificationsChanged } from "../lib/notificationsEvents";


// ✅ Match backend response
type ApiNotification = {
  id: number;
  type: string;
  content: any;          // can be string or object depending on your DB usage
  read: boolean;
  createdAt: string;
};

// ✅ UI-friendly shape
export type NotificationItem = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdAt: string;
};

type ListResp = {
  items: ApiNotification[];
  pageInfo: { limit: number; nextCursor: number | null };
};

function toUiItem(n: ApiNotification): NotificationItem {
  // content might be a string, or an object like { title, body }
  const content = n.content;

  let title = n.type;
  let body: string | null = null;

  if (typeof content === "string") {
    body = content;
  } else if (content && typeof content === "object") {
    if (typeof content.title === "string") title = content.title;
    if (typeof content.body === "string") body = content.body;
    if (!body && typeof content.message === "string") body = content.message;
    if (!body && typeof content.text === "string") body = content.text;
  }

  return {
    id: n.id,
    type: n.type,
    title,
    body,
    isRead: !!n.read,
    createdAt: n.createdAt,
  };
}

export function useNotifications(pollMs: number = 30000) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchList = useCallback(
    async (mode: "initial" | "refresh" | "poll") => {
      if (mode === "initial") setLoading(true);
      if (mode === "refresh") setRefreshing(true);

      try {
        setError(null);

        // ✅ query params: cursor, limit
        const data = await api.get<ListResp>("/notifications", { limit: 50 });

        const uiItems = (data.items ?? []).map(toUiItem);
        setItems(uiItems);
        emitNotificationsChanged();
      } catch (e: any) {
        setError(e?.message ?? "Failed to load notifications");
      } finally {
        if (mode === "initial") setLoading(false);
        if (mode === "refresh") setRefreshing(false);
      }
    },
    []
  );

  const refetch = useCallback(() => fetchList("refresh"), [fetchList]);

  const markRead = useCallback(
    async (id: number) => {
      // optimistic
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
      emitNotificationsChanged();


      try {
        // ✅ backend is POST /notifications/:id/read
        await api.post(`/notifications/${id}/read`, {});
      } catch {
        // revert via refetch
        fetchList("refresh");
      }
    },
    [fetchList]
  );

  const markAllRead = useCallback(async () => {
    // optimistic
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true })));
    emitNotificationsChanged();


    try {
      // ✅ backend is POST /notifications/read-all
      await api.post("/notifications/read-all", {});
    } catch {
      fetchList("refresh");
    }
  }, [fetchList]);

  useEffect(() => {
    fetchList("initial");

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => fetchList("poll"), pollMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [fetchList, pollMs]);

  return {
    items,
    loading,
    refreshing,
    error,
    refetch,
    markRead,
    markAllRead,
  };
}
