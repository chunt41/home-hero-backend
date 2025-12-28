import { api } from "./apiClient";

export type AuthResponse =
  | { token: string }
  | { accessToken: string }
  | { jwt: string };

export async function apiPost<T>(
  path: string,
  body: unknown,
  token?: string
): Promise<T> {
  // NOTE: token param is retained for backwards compatibility but is currently ignored.
  // The canonical client reads the auth token from SecureStore.
  void token;
  return api.post<T>(path, body);
}
