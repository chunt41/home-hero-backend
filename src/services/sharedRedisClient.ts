import { createClient } from "redis";
import { env } from "../config/env";

export type SharedRedisClient = ReturnType<typeof createClient>;

let _client: SharedRedisClient | null = null;
let _connectPromise: Promise<unknown> | null = null;

export function getSharedRedisUrlOrNull(): string | null {
  const url = (env.RATE_LIMIT_REDIS_URL ?? "").trim();
  return url ? url : null;
}

export function ensureSharedRedisClientOrThrow(): SharedRedisClient {
  if (_client) return _client;

  const url = getSharedRedisUrlOrNull();
  if (!url) {
    throw new Error("RATE_LIMIT_REDIS_URL is not configured");
  }

  const client = createClient({ url });
  client.on("error", () => {
    // Callers handle fail-open behavior.
  });

  _client = client;
  return client;
}

export async function ensureSharedRedisConnected(): Promise<SharedRedisClient> {
  const client = ensureSharedRedisClientOrThrow();
  if (client.isReady) return client;

  if (!_connectPromise) {
    _connectPromise = client.connect();
  }
  await _connectPromise;
  return client;
}
