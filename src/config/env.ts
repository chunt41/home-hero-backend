// src/config/env.ts
import * as dotenv from "dotenv";

// Load .env as early as possible (dotenv does not override existing process.env by default).
dotenv.config();

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

  // Stripe
  STRIPE_SECRET_KEY: requireEnv("STRIPE_SECRET_KEY"),
  // Publishable key is used by the mobile app, not required on the backend.
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,

  // Worker tuning (optional)
  WEBHOOK_WORKER_POLL_MS: Number(process.env.WEBHOOK_WORKER_POLL_MS ?? 1000),
};
