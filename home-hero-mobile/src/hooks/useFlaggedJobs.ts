import { useState, useEffect } from "react";
import { api } from "../lib/apiClient";

export function useFlaggedJobs() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<any[]>("/admin/flagged-jobs")
      .then(setJobs)
      .catch((err) => setError(err?.message || "Failed to fetch flagged jobs"))
      .finally(() => setLoading(false));
  }, []);

  return { jobs, loading, error };
}
