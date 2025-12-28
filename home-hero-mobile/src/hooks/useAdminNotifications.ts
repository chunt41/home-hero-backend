import { useState, useEffect } from "react";
import { api } from "../lib/apiClient";

export function useAdminNotifications() {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<any[]>("/admin/notifications")
      .then(setNotifications)
      .catch((err) => setError(err?.message || "Failed to fetch notifications"))
      .finally(() => setLoading(false));
  }, []);

  return { notifications, loading, error };
}

export function useAdminLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<any[]>("/admin/logs")
      .then(setLogs)
      .catch((err) => setError(err?.message || "Failed to fetch logs"))
      .finally(() => setLoading(false));
  }, []);

  return { logs, loading, error };
}
