import { useState, useEffect } from "react";
import { api } from "../lib/apiClient";

export function useAdminUsers(search: string = "") {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<any[]>("/admin/users", search ? { q: search } : undefined)
      .then(setUsers)
      .catch((err) => setError(err?.message || "Failed to fetch users"))
      .finally(() => setLoading(false));
  }, [search]);

  return { users, loading, error };
}
