import test from "node:test";
import assert from "node:assert/strict";

import { validateAttestationStartupOrThrow } from "./startupValidation";

function restoreEnv(oldEnv: NodeJS.ProcessEnv) {
  for (const k of Object.keys(process.env)) {
    if (!(k in oldEnv)) delete (process.env as any)[k];
  }
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete (process.env as any)[k];
    else process.env[k] = v;
  }
}

test("startupValidation: does nothing when not production", () => {
  const oldEnv = { ...process.env };
  process.env.NODE_ENV = "test";
  process.env.APP_ATTESTATION_ENFORCE = "true";
  delete (process.env as any).ANDROID_PLAY_INTEGRITY_PACKAGE_NAME;

  validateAttestationStartupOrThrow();

  restoreEnv(oldEnv);
});

test("startupValidation: fails fast in production when enforced and missing Android config", () => {
  const oldEnv = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.APP_ATTESTATION_PLATFORMS = "android";

  delete (process.env as any).ANDROID_PLAY_INTEGRITY_PACKAGE_NAME;
  delete (process.env as any).ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS;
  delete (process.env as any).GOOGLE_SERVICE_ACCOUNT_JSON;
  delete (process.env as any).GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  delete (process.env as any).GOOGLE_APPLICATION_CREDENTIALS;

  assert.throws(() => validateAttestationStartupOrThrow(), (e: any) => {
    const msg = String(e?.message ?? e);
    return msg.includes("FATAL") && msg.includes("ANDROID_PLAY_INTEGRITY_PACKAGE_NAME");
  });

  restoreEnv(oldEnv);
});

test("startupValidation: fails fast in production when enforced and missing iOS config", () => {
  const oldEnv = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.APP_ATTESTATION_PLATFORMS = "ios";

  delete (process.env as any).IOS_APP_ATTEST_BUNDLE_ID;
  delete (process.env as any).IOS_APP_ATTEST_ALLOWED_KEY_IDS;
  delete (process.env as any).IOS_APP_ATTEST_VERIFY_URL;

  assert.throws(() => validateAttestationStartupOrThrow(), (e: any) => {
    const msg = String(e?.message ?? e);
    return msg.includes("FATAL") && msg.includes("IOS_APP_ATTEST_BUNDLE_ID");
  });

  restoreEnv(oldEnv);
});
