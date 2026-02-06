import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "../config";
import { getAppAttestationToken } from "./attestation";

// Set in home-hero-mobile/.env as EXPO_PUBLIC_API_BASE_URL=https://...
// Falls back to src/config.ts default when not provided.
const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? API_BASE_URL ?? "";
const TOKEN_KEY = "homeHero.authToken";

const DEFAULT_TIMEOUT_MS = 15000;

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiError = { status: number; message: string; details?: unknown };

export function extractApiErrorMessage(details: unknown, fallback: string): string {
  if (typeof details === "string") {
    const s = details.trim();
    return s ? s : fallback;
  }

  if (details && typeof details === "object") {
    const anyDetails = details as any;

    if (typeof anyDetails.error === "string" && anyDetails.error.trim()) {
      return anyDetails.error;
    }

    if (typeof anyDetails.message === "string" && anyDetails.message.trim()) {
      return anyDetails.message;
    }

    if (typeof anyDetails.detail === "string" && anyDetails.detail.trim()) {
      return anyDetails.detail;
    }

    // Common validation error shapes
    const list =
      (Array.isArray(anyDetails.errors) && anyDetails.errors) ||
      (Array.isArray(anyDetails.issues) && anyDetails.issues) ||
      null;

    if (list && list.length) {
      const messages = list
        .map((item: any) => {
          if (!item) return null;
          if (typeof item === "string") return item;
          if (typeof item.message === "string") return item.message;
          return null;
        })
        .filter(Boolean) as string[];

      if (messages.length) return messages.join("\n");
    }
  }

  return fallback;
}

async function readToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveAuthToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function deleteAuthToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // ignore
  }
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${BASE_URL}${p}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  query?: Record<string, unknown>
): Promise<T> {
  if (!BASE_URL) {
    throw {
      status: 0,
      message: "App is missing API base URL configuration.",
      details: { missing: "EXPO_PUBLIC_API_BASE_URL", fallback: API_BASE_URL ?? null },
    } as ApiError;
  }

  const token = await readToken();
  const attestationToken = await getAppAttestationToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-App-Attestation": attestationToken,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = buildUrl(path, query);

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e: any) {
    const isAbort = e?.name === "AbortError";
    const err: ApiError = {
      status: 0,
      message: isAbort ? "Request timed out. Please try again." : "Network request failed. Please check your connection.",
      details: {
        url,
        baseUrl: BASE_URL,
        cause: String(e?.message || e),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
    };
    throw err;
  }

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const message = extractApiErrorMessage(data, res.statusText || "Request failed");

    const err: ApiError = { status: res.status, message, details: data };
    throw err;
  }

  return data as T;
}

async function requestForm<T>(
  method: HttpMethod,
  path: string,
  form: FormData,
  query?: Record<string, unknown>
): Promise<T> {
  if (!BASE_URL) {
    throw {
      status: 0,
      message: "App is missing API base URL configuration.",
      details: { missing: "EXPO_PUBLIC_API_BASE_URL", fallback: API_BASE_URL ?? null },
    } as ApiError;
  }

  const token = await readToken();
  const attestationToken = await getAppAttestationToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-App-Attestation": attestationToken,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const url = buildUrl(path, query);

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    res = await fetch(url, {
      method,
      headers,
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e: any) {
    const isAbort = e?.name === "AbortError";
    const err: ApiError = {
      status: 0,
      message: isAbort ? "Request timed out. Please try again." : "Network request failed. Please check your connection.",
      details: {
        url,
        baseUrl: BASE_URL,
        cause: String(e?.message || e),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
    };
    throw err;
  }

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const message = extractApiErrorMessage(data, res.statusText || "Request failed");
    const err: ApiError = { status: res.status, message, details: data };
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

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>) =>
    request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>("POST", path, body, query),
  put: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>("PUT", path, body, query),
  patch: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
    request<T>("PATCH", path, body, query),
  delete: <T>(path: string, query?: Record<string, unknown>) =>
    request<T>("DELETE", path, undefined, query),

  upload: <T>(path: string, form: FormData, query?: Record<string, unknown>) =>
    requestForm<T>("POST", path, form, query),
};
