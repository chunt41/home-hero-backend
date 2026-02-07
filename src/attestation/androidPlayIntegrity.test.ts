import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";

import { verifyAndroidPlayIntegrityAttestation } from "./androidPlayIntegrity";

function restoreEnv(oldEnv: NodeJS.ProcessEnv) {
  for (const k of Object.keys(process.env)) {
    if (!(k in oldEnv)) delete (process.env as any)[k];
  }
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete (process.env as any)[k];
    else process.env[k] = v;
  }
}

function makeServiceAccountJson() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  return JSON.stringify({
    type: "service_account",
    client_email: "play-integrity@test.invalid",
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

function makeMockFetch(okVerdict: any) {
  return (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "ya29.mock", token_type: "Bearer", expires_in: 3600 };
        },
      } as any;
    }

    if (u.includes("playintegrity.googleapis.com")) {
      // Ensure we never leak the token in test output by throwing.
      assert.equal(typeof init?.headers?.authorization, "string");
      assert.match(String(init.headers.authorization), /^Bearer\s+ya29\./);

      return {
        ok: true,
        status: 200,
        async json() {
          return { tokenPayloadExternal: okVerdict };
        },
      } as any;
    }

    throw new Error(`Unexpected URL: ${u}`);
  }) as any;
}

test("androidPlayIntegrity: rejects package mismatch", async () => {
  const oldEnv = { ...process.env };
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = makeServiceAccountJson();
  process.env.ANDROID_PLAY_INTEGRITY_PACKAGE_NAME = "com.example.app";
  process.env.ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS = "abc123==";

  const verdict = {
    requestDetails: {
      requestPackageName: "com.other.app",
      timestampMillis: String(Date.now()),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      certificateSha256Digest: ["abc123=="],
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
    },
  };

  const fetchImpl = makeMockFetch(verdict);
  await assert.rejects(() =>
    verifyAndroidPlayIntegrityAttestation("integrity-token", { fetchImpl })
  );

  restoreEnv(oldEnv);
});

test("androidPlayIntegrity: rejects when device integrity verdict not allowed", async () => {
  const oldEnv = { ...process.env };
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = makeServiceAccountJson();
  process.env.ANDROID_PLAY_INTEGRITY_PACKAGE_NAME = "com.example.app";
  process.env.ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS = "abc123==";

  const verdict = {
    requestDetails: {
      requestPackageName: "com.example.app",
      timestampMillis: String(Date.now()),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      certificateSha256Digest: ["abc123=="],
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"],
    },
  };

  const fetchImpl = makeMockFetch(verdict);
  await assert.rejects(() =>
    verifyAndroidPlayIntegrityAttestation("integrity-token", { fetchImpl })
  );

  restoreEnv(oldEnv);
});
