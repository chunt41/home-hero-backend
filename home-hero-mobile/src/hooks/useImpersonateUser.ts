import { api } from "../../src/lib/apiClient";

export async function impersonateUser(userId: number): Promise<string> {
  const res = await api.post<{ token: string }>(`/admin/impersonate/${userId}`);
  return res.token;
}
