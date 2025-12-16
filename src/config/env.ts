// src/config/env.ts
function requireEnv(name: string) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: Number(process.env.PORT ?? 4000),

  DATABASE_URL: requireEnv("DATABASE_URL"),
  JWT_SECRET: requireEnv("JWT_SECRET"),

  // Worker tuning (optional)
  WEBHOOK_WORKER_POLL_MS: Number(process.env.WEBHOOK_WORKER_POLL_MS ?? 1000),
};
