import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function getRepoRoot(): string {
  // This test file lives at src/productionReadiness/*.test.ts
  return path.resolve(__dirname, "..", "..");
}

test("production readiness: .env.example includes required production keys", () => {
  const envExamplePath = path.join(getRepoRoot(), ".env.example");
  const content = fs.readFileSync(envExamplePath, "utf8");

  const requiredKeys = [
    // Core runtime
    "DATABASE_URL",
    "JWT_SECRET",

    // Stripe
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",

    // Rate limiting
    "RATE_LIMIT_REDIS_URL",

    // Object storage
    "OBJECT_STORAGE_PROVIDER",
    "OBJECT_STORAGE_S3_BUCKET",
    "OBJECT_STORAGE_S3_REGION",
    "OBJECT_STORAGE_S3_ACCESS_KEY_ID",
    "OBJECT_STORAGE_S3_SECRET_ACCESS_KEY",

    // Attestation (enforced => required)
    "APP_ATTESTATION_ENFORCE",
    "ANDROID_PLAY_INTEGRITY_PACKAGE_NAME",
    "ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "IOS_APP_ATTEST_BUNDLE_ID",
    "IOS_APP_ATTEST_ALLOWED_KEY_IDS",
    "IOS_APP_ATTEST_VERIFY_URL",
  ];

  for (const key of requiredKeys) {
    assert.ok(content.includes(`${key}=`), `Expected .env.example to include ${key}`);
  }
});
