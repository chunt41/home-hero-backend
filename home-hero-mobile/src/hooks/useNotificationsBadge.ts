import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/apiClient";
import { onNotificationsChanged } from "../lib/notificationsEvents";

type BackendNotif = { id: number; read: boolean };

type ListResp = {
  items: BackendNotif[];
  pageInfo: { limit: number; nextCursor: number | null };
};

export function useNotificationsBadge(pollMs: number = 30000) {
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const timerRef = useRef<any>(null);

  const fetchUnread = useCallback(async () => {
    try {
      // Grab enough to count unread; bump limit if needed
      const data = await api.get<ListResp>("/notifications", { limit: 100 });
      const items = data.items ?? [];
      const count = items.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);
      setUnreadCount(count);
    } catch {
      // don’t crash badge; keep last known value
    }
  }, []);

  useEffect(() => {
    fetchUnread();

    // Poll (optional but nice)
    timerRef.current = setInterval(fetchUnread, pollMs);

    // React immediately when notifications change (mark read, read-all, etc.)
    const unsub = onNotificationsChanged(() => {
      fetchUnread();
    });

    return () => {
      unsub();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchUnread, pollMs]);

  return { unreadCount, refetchUnread: fetchUnread };
}
