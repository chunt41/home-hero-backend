import test from "node:test";
import assert from "node:assert/strict";

import { validateAttestationStartupOrThrow } from "../attestation/startupValidation";
import { validateRateLimitRedisStartupOrThrow } from "../middleware/rateLimitRedis";
import { validateObjectStorageStartupOrThrow } from "../storage/storageFactory";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (typeof v === "undefined") {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("production readiness: Redis rate limit env required in production", () => {
  withEnv({ NODE_ENV: "production", RATE_LIMIT_REDIS_URL: undefined }, () => {
    assert.throws(() => validateRateLimitRedisStartupOrThrow(), /RATE_LIMIT_REDIS_URL/);
  });

  withEnv({ NODE_ENV: "production", RATE_LIMIT_REDIS_URL: "redis://localhost:6379" }, () => {
    assert.doesNotThrow(() => validateRateLimitRedisStartupOrThrow());
  });
});

test("production readiness: object storage must be S3 in prod unless escape hatch", () => {
  withEnv(
    {
      NODE_ENV: "production",
      OBJECT_STORAGE_PROVIDER: "disk",
      OBJECT_STORAGE_ALLOW_DISK_IN_PROD: "false",
    },
    () => {
      assert.throws(() => validateObjectStorageStartupOrThrow(), /OBJECT_STORAGE_PROVIDER/);
    }
  );

  withEnv(
    {
      NODE_ENV: "production",
      OBJECT_STORAGE_PROVIDER: "disk",
      OBJECT_STORAGE_ALLOW_DISK_IN_PROD: "true",
    },
    () => {
      assert.doesNotThrow(() => validateObjectStorageStartupOrThrow());
    }
  );

  // S3 provider must have required config.
  withEnv(
    {
      NODE_ENV: "production",
      OBJECT_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_ALLOW_DISK_IN_PROD: "false",
      OBJECT_STORAGE_S3_BUCKET: "",
      OBJECT_STORAGE_S3_REGION: "",
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "",
    },
    () => {
      assert.throws(() => validateObjectStorageStartupOrThrow());
    }
  );

  withEnv(
    {
      NODE_ENV: "production",
      OBJECT_STORAGE_PROVIDER: "s3",
      OBJECT_STORAGE_ALLOW_DISK_IN_PROD: "false",
      OBJECT_STORAGE_S3_BUCKET: "bucket",
      OBJECT_STORAGE_S3_REGION: "us-east-1",
      OBJECT_STORAGE_S3_ACCESS_KEY_ID: "akid",
      OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    },
    () => {
      assert.doesNotThrow(() => validateObjectStorageStartupOrThrow());
    }
  );
});

test("production readiness: attestation enforcement fails fast when missing config", () => {
  withEnv(
    {
      NODE_ENV: "production",
      APP_ATTESTATION_ENFORCE: "true",
      APP_ATTESTATION_PLATFORMS: "android",
      ANDROID_PLAY_INTEGRITY_PACKAGE_NAME: "",
      ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS: "",
      GOOGLE_SERVICE_ACCOUNT_JSON: "",
      GOOGLE_SERVICE_ACCOUNT_JSON_B64: "",
      GOOGLE_APPLICATION_CREDENTIALS: "",
    },
    () => {
      assert.throws(() => validateAttestationStartupOrThrow(), /App attestation is enforced/);
    }
  );
});
