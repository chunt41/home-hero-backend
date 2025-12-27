import * as SecureStore from "expo-secure-store";

// Set in home-hero-mobile/.env as EXPO_PUBLIC_API_BASE_URL=https://...
const BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
const TOKEN_KEY = "homeHero.authToken";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiError = { status: number; message: string; details?: unknown };

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
    throw { status: 0, message: "Missing EXPO_PUBLIC_API_BASE_URL", details: null } as ApiError;
  }

  const token = await readToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const message =
      (data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as any).error === "string"
        ? (data as any).error
        : res.statusText) || "Request failed";

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
};
