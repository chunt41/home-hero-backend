import type { ApiError } from "./apiClient";

function isApiError(x: unknown): x is ApiError {
  return (
    !!x &&
    typeof x === "object" &&
    "message" in x &&
    typeof (x as any).message === "string" &&
    "status" in x &&
    typeof (x as any).status === "number"
  );
}

export function getErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || fallback;
  if (isApiError(err)) return err.message || fallback;

  // Some code throws plain objects like { error: "..." }
  if (err && typeof err === "object") {
    const anyErr = err as any;
    if (typeof anyErr.error === "string") return anyErr.error;
    if (typeof anyErr.message === "string") return anyErr.message;
  }

  try {
    const s = String(err);
    return s && s !== "[object Object]" ? s : fallback;
  } catch {
    return fallback;
  }
}
