import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as jwt from "jsonwebtoken";

import { createAttestationVerifier } from "./requireAttestation";

test("attestation verifier: accepts valid JWT signed by configured key", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const oldKey = process.env.APP_ATTESTATION_PUBLIC_KEY_PEM;
  const oldAlg = process.env.APP_ATTESTATION_JWT_ALG;

  process.env.APP_ATTESTATION_PUBLIC_KEY_PEM = publicKey;
  process.env.APP_ATTESTATION_JWT_ALG = "RS256";

  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      platform: "android",
      deviceId: "device-123",
      riskLevel: "low",
      iat: now,
      exp: now + 60,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  const verifier = createAttestationVerifier();
  const result = await verifier.verify(token);

  assert.equal(result.attested, true);
  assert.equal(result.attestation.platform, "android");
  assert.equal(result.attestation.deviceId, "device-123");
  assert.equal(result.attestation.riskLevel, "low");

  process.env.APP_ATTESTATION_PUBLIC_KEY_PEM = oldKey;
  process.env.APP_ATTESTATION_JWT_ALG = oldAlg;
});

test("attestation verifier: rejects expired token", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const oldKey = process.env.APP_ATTESTATION_PUBLIC_KEY_PEM;
  const oldAlg = process.env.APP_ATTESTATION_JWT_ALG;

  process.env.APP_ATTESTATION_PUBLIC_KEY_PEM = publicKey;
  process.env.APP_ATTESTATION_JWT_ALG = "RS256";

  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      platform: "ios",
      deviceId: "device-xyz",
      iat: now - 120,
      exp: now - 60,
    },
    privateKey,
    { algorithm: "RS256" }
  );

  const verifier = createAttestationVerifier();
  await assert.rejects(() => verifier.verify(token));

  process.env.APP_ATTESTATION_PUBLIC_KEY_PEM = oldKey;
  process.env.APP_ATTESTATION_JWT_ALG = oldAlg;
});
