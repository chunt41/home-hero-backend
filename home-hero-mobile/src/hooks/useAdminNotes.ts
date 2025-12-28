import { useState, useEffect } from "react";
import { api } from "../../src/lib/apiClient";

export function useAdminNotes(type: "user" | "job", id: number) {
  const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<any[]>(`/admin/${type}/${id}/notes`)
      .then(setNotes)
      .catch((err) => setError(err?.message || "Failed to fetch notes"))
      .finally(() => setLoading(false));
  }, [type, id]);

  const addNote = async (note: string) => {
    const newNote = await api.post<any>(`/admin/${type}/${id}/notes`, { note });
    setNotes((prev) => [newNote, ...prev]);
  };

  return { notes, loading, error, addNote };
}
