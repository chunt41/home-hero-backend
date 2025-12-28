import { API_BASE_URL } from "../config";
import { extractApiErrorMessage, type ApiError } from "../lib/apiClient";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function http<T>(
  path: string,
  opts: {
    method?: HttpMethod;
    token?: string;
    body?: any;
  } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e: any) {
    const err: ApiError = {
      status: 0,
      message: "Network request failed. Please check your connection.",
      details: { cause: String(e?.message || e), path },
    };
    throw err;
  }

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      message: extractApiErrorMessage(data, res.statusText || "Request failed"),
      details: data,
    };
    throw err;
  }

  return data as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
