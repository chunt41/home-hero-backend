import fetch from "node-fetch";

export type ExpoPushMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, any>;
  sound?: "default";
  priority?: "default" | "normal" | "high";
};

export function isExpoPushToken(token: string): boolean {
  return typeof token === "string" && (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["));
}

export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<void> {
  if (!messages.length) return;

  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Expo push send failed: ${res.status} ${text}`);
  }

  // Expo returns a JSON receipt with potential per-message errors; we log but don't fail the whole job.
  const json = (await res.json().catch(() => null)) as any;
  if (json?.data && Array.isArray(json.data)) {
    const errors = json.data.filter((d: any) => d?.status === "error");
    if (errors.length) {
      console.warn("[expo push] some messages failed", errors);
    }
  }
}
