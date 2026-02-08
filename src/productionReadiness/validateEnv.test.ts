import test from "node:test";
import assert from "node:assert/strict";
import { validateEnv, validateEnvAtStartup } from "../config/validateEnv";

function withEnv(patch: Partial<NodeJS.ProcessEnv>, fn: () => void) {
  const prev = { ...process.env };
  try {
    // Avoid leaking env across tests.
    for (const k of Object.keys(process.env)) {
      // Keep Node internals untouched.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.env as any)[k];
    }
    Object.assign(process.env, prev);
    Object.assign(process.env, patch);
    fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.env as any)[k];
    }
    Object.assign(process.env, prev);
  }
}

test("startup env validation: production fails fast when required vars missing", () => {
  withEnv(
    {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      JWT_SECRET: "test",
      STRIPE_SECRET_KEY: "sk_test_123",

      // Intentionally missing:
      // - RATE_LIMIT_REDIS_URL
      // - STRIPE_WEBHOOK_SECRET
      // - OBJECT_STORAGE_* (prod requires s3)
      // - EMAIL_PROVIDER / EMAIL_FROM
    },
    () => {
      const r = validateEnv(process.env);
      assert.ok(r.errors.length > 0);

      assert.ok(r.errors.some((e) => e.group === "Redis / Rate Limiting"));
      assert.ok(r.errors.some((e) => e.group === "Stripe"));
      assert.ok(r.errors.some((e) => e.group === "Object Storage"));
      assert.ok(r.errors.some((e) => e.group === "Email"));

      assert.throws(() => validateEnvAtStartup(process.env), /FATAL: Startup environment validation failed/);
    }
  );
});

test("startup env validation: non-prod warns for optional features but does not throw", () => {
  withEnv(
    {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      JWT_SECRET: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
    },
    () => {
      const warns: string[] = [];
      const prevWarn = console.warn;
      console.warn = (...args: any[]) => {
        warns.push(args.map(String).join(" "));
      };

      try {
        assert.doesNotThrow(() => validateEnvAtStartup(process.env));
      } finally {
        console.warn = prevWarn;
      }

      // Should emit at least one warning (redis/webhook/object storage/email).
      assert.ok(warns.join("\n").includes("WARNING: Startup environment validation"));
    }
  );
});

test("startup env validation: attestation config is required only when enforcement is ON", () => {
  withEnv(
    {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      JWT_SECRET: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      RATE_LIMIT_REDIS_URL: "redis://localhost:6379",
      OBJECT_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_S3_BUCKET: "bucket",
      OBJECT_STORAGE_S3_REGION: "us-east-1",
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "ak",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "sk",
      EMAIL_PROVIDER: "smtp",
      EMAIL_FROM: "noreply@example.com",
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_USER: "u",
      SMTP_PASS: "p",

      // Enforcement OFF => should not require verifier vars.
      APP_ATTESTATION_ENFORCE: "false",
    },
    () => {
      assert.doesNotThrow(() => validateEnvAtStartup(process.env));
    }
  );

  withEnv(
    {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      JWT_SECRET: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      RATE_LIMIT_REDIS_URL: "redis://localhost:6379",
      OBJECT_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_S3_BUCKET: "bucket",
      OBJECT_STORAGE_S3_REGION: "us-east-1",
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "ak",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "sk",
      EMAIL_PROVIDER: "smtp",
      EMAIL_FROM: "noreply@example.com",
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_USER: "u",
      SMTP_PASS: "p",

      // Enforcement ON but missing verifier vars => must fail.
      APP_ATTESTATION_ENFORCE: "true",
      APP_ATTESTATION_PLATFORMS: "android",
    },
    () => {
      const r = validateEnv(process.env);
      assert.ok(r.errors.some((e) => e.group === "Attestation"));
      assert.throws(() => validateEnvAtStartup(process.env), /\[Attestation\]/);
    }
  );
});
