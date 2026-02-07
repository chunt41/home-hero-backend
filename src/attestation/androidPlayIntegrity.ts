import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import fetch from "node-fetch";

import { AttestationError } from "./attestationError";

export type AndroidPlayIntegrityVerdict = {
  requestDetails?: {
    requestPackageName?: string;
    timestampMillis?: string | number;
    nonce?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    certificateSha256Digest?: string[];
    // some SDKs/versions use slightly different casing; we tolerate unknown keys.
    [k: string]: unknown;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
    [k: string]: unknown;
  };
  accountDetails?: {
    appLicensingVerdict?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type AndroidPlayIntegrityVerificationOptions = {
  expectedNonce?: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseCommaList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return String(raw).toLowerCase() === "true";
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

async function loadServiceAccountFromEnv(): Promise<ServiceAccountKey> {
  /**
   * Required env vars (service account):
   * - GOOGLE_SERVICE_ACCOUNT_JSON: raw JSON string for a service account key
   *   OR
   * - GOOGLE_SERVICE_ACCOUNT_JSON_B64: base64 of the JSON string (easier for CI)
   *   OR
   * - GOOGLE_APPLICATION_CREDENTIALS: path to the JSON key file (standard)
   */
  const jsonB64 = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 ?? "").trim();
  const jsonRaw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "").trim();
  const path = (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();

  let json: string | null = null;
  if (jsonB64) json = Buffer.from(jsonB64, "base64").toString("utf8");
  else if (jsonRaw) json = jsonRaw;
  else if (path) json = await fs.readFile(path, "utf8");

  if (!json) {
    throw new AttestationError(
      "Play Integrity verification is not configured (missing service account credentials)",
      503,
      "PLAY_INTEGRITY_NOT_CONFIGURED"
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AttestationError(
      "Play Integrity service account JSON is invalid",
      503,
      "PLAY_INTEGRITY_BAD_SERVICE_ACCOUNT"
    );
  }

  const client_email = String(parsed?.client_email ?? "").trim();
  const private_key = String(parsed?.private_key ?? "").trim();
  const token_uri = String(parsed?.token_uri ?? "https://oauth2.googleapis.com/token").trim();

  if (!client_email || !private_key) {
    throw new AttestationError(
      "Play Integrity service account JSON missing client_email/private_key",
      503,
      "PLAY_INTEGRITY_BAD_SERVICE_ACCOUNT"
    );
  }

  return { client_email, private_key, token_uri };
}

async function getAccessToken(fetchImpl: typeof fetch): Promise<string> {
  // Required scope for Play Integrity API.
  const scope = "https://www.googleapis.com/auth/playintegrity";
  const sa = await loadServiceAccountFromEnv();
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud,
      iat: now,
      exp: now + 60 * 10,
    })
  );
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.private_key));

  const assertion = `${unsigned}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const resp = await fetchImpl(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    // Do not log assertion.
    throw new AttestationError(
      `Play Integrity OAuth failed (${resp.status})`,
      503,
      "PLAY_INTEGRITY_OAUTH_FAILED"
    );
  }

  const json = (await resp.json()) as any;
  const accessToken = String(json?.access_token ?? "").trim();
  if (!accessToken) {
    throw new AttestationError(
      "Play Integrity OAuth response missing access_token",
      503,
      "PLAY_INTEGRITY_OAUTH_FAILED"
    );
  }

  return accessToken;
}

function getExpectedAndroidConfig() {
  /**
   * Required env vars (Android Play Integrity policy):
   * - ANDROID_PLAY_INTEGRITY_PACKAGE_NAME: expected Android applicationId
   * - ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS: comma-separated list of allowed cert SHA-256 digests
   *   (these are the base64 digests Play Integrity returns in certificateSha256Digest)
   *
   * Optional policy env vars:
   * - ANDROID_PLAY_INTEGRITY_MAX_TOKEN_AGE_SECONDS: freshness window (default 300)
   * - ANDROID_PLAY_INTEGRITY_MAX_FUTURE_SKEW_SECONDS: allow small future skew (default 60)
   * - ANDROID_PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS: comma-separated (default "MEETS_DEVICE_INTEGRITY,MEETS_STRONG_INTEGRITY")
   * - ANDROID_PLAY_INTEGRITY_REQUIRE_PLAY_RECOGNIZED: default true
   * - ANDROID_PLAY_INTEGRITY_REQUIRE_LICENSED: default false
   */
  const expectedPackageName = String(process.env.ANDROID_PLAY_INTEGRITY_PACKAGE_NAME ?? "").trim();
  const allowedCertDigests = parseCommaList(process.env.ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS);

  if (!expectedPackageName) {
    throw new AttestationError(
      "Play Integrity verification is not configured (missing ANDROID_PLAY_INTEGRITY_PACKAGE_NAME)",
      503,
      "PLAY_INTEGRITY_NOT_CONFIGURED"
    );
  }

  if (!allowedCertDigests.length) {
    throw new AttestationError(
      "Play Integrity verification is not configured (missing ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS)",
      503,
      "PLAY_INTEGRITY_NOT_CONFIGURED"
    );
  }

  const maxAgeSeconds = envInt("ANDROID_PLAY_INTEGRITY_MAX_TOKEN_AGE_SECONDS", 300);
  const maxFutureSkewSeconds = envInt("ANDROID_PLAY_INTEGRITY_MAX_FUTURE_SKEW_SECONDS", 60);
  const allowedDeviceVerdicts = parseCommaList(
    process.env.ANDROID_PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS ??
      "MEETS_DEVICE_INTEGRITY,MEETS_STRONG_INTEGRITY"
  );
  const requirePlayRecognized = envBool("ANDROID_PLAY_INTEGRITY_REQUIRE_PLAY_RECOGNIZED", true);
  const requireLicensed = envBool("ANDROID_PLAY_INTEGRITY_REQUIRE_LICENSED", false);

  return {
    expectedPackageName,
    allowedCertDigests,
    maxAgeMs: maxAgeSeconds * 1000,
    maxFutureSkewMs: maxFutureSkewSeconds * 1000,
    allowedDeviceVerdicts,
    requirePlayRecognized,
    requireLicensed,
  };
}

function requireString(value: unknown, errMsg: string, code: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new AttestationError(errMsg, 401, code);
  return s;
}

function parseTimestampMillis(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) {
    throw new AttestationError(
      "Play Integrity verdict missing timestamp",
      401,
      "PLAY_INTEGRITY_NO_TIMESTAMP"
    );
  }
  return n;
}

function requireFreshTimestamp(tsMs: number, nowMs: number, maxAgeMs: number, maxFutureSkewMs: number) {
  if (tsMs > nowMs + maxFutureSkewMs) {
    throw new AttestationError(
      "Play Integrity verdict timestamp is in the future",
      401,
      "PLAY_INTEGRITY_TIMESTAMP_FUTURE"
    );
  }

  const age = nowMs - tsMs;
  if (age > maxAgeMs) {
    throw new AttestationError(
      "Play Integrity verdict is too old",
      401,
      "PLAY_INTEGRITY_STALE"
    );
  }
}

function normalizeArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

export async function decodeAndVerifyAndroidPlayIntegrityToken(
  integrityToken: string,
  opts: AndroidPlayIntegrityVerificationOptions = {}
): Promise<{ verdict: AndroidPlayIntegrityVerdict; packageName: string; timestampMs: number }>
{
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { expectedPackageName } = getExpectedAndroidConfig();

  const accessToken = await getAccessToken(fetchImpl);
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(expectedPackageName)}:decodeIntegrityToken`;

  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ integrityToken }),
  });

  if (!resp.ok) {
    throw new AttestationError(
      `Play Integrity API error (${resp.status})`,
      401,
      "PLAY_INTEGRITY_API_ERROR"
    );
  }

  const json = (await resp.json()) as any;
  const verdict = (json?.tokenPayloadExternal ?? null) as AndroidPlayIntegrityVerdict | null;
  if (!verdict || typeof verdict !== "object") {
    throw new AttestationError(
      "Play Integrity API response missing tokenPayloadExternal",
      401,
      "PLAY_INTEGRITY_BAD_RESPONSE"
    );
  }

  const packageName = requireString(
    verdict.requestDetails?.requestPackageName,
    "Play Integrity verdict missing package name",
    "PLAY_INTEGRITY_NO_PACKAGE"
  );
  const timestampMs = parseTimestampMillis(verdict.requestDetails?.timestampMillis);

  return { verdict, packageName, timestampMs };
}

export async function verifyAndroidPlayIntegrityAttestation(
  integrityToken: string,
  opts: AndroidPlayIntegrityVerificationOptions = {}
): Promise<{
  attested: true;
  attestation: {
    platform: "android";
    deviceId: string;
    issuedAt: string;
    riskLevel: "low";
  };
}> {
  if (typeof integrityToken !== "string" || !integrityToken.trim()) {
    throw new AttestationError("Missing Play Integrity token", 401, "PLAY_INTEGRITY_MISSING_TOKEN");
  }

  const config = getExpectedAndroidConfig();
  const nowMs = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();

  const { verdict, packageName, timestampMs } = await decodeAndVerifyAndroidPlayIntegrityToken(
    integrityToken,
    opts
  );

  if (packageName !== config.expectedPackageName) {
    throw new AttestationError(
      "Play Integrity verdict package mismatch",
      401,
      "PLAY_INTEGRITY_PACKAGE_MISMATCH"
    );
  }

  requireFreshTimestamp(timestampMs, nowMs, config.maxAgeMs, config.maxFutureSkewMs);

  const certDigests = normalizeArray(verdict.appIntegrity?.certificateSha256Digest);
  if (!certDigests.length || !intersects(config.allowedCertDigests, certDigests)) {
    throw new AttestationError(
      "Play Integrity verdict certificate digest mismatch",
      401,
      "PLAY_INTEGRITY_CERT_MISMATCH"
    );
  }

  const deviceVerdicts = normalizeArray(verdict.deviceIntegrity?.deviceRecognitionVerdict);
  if (!deviceVerdicts.length || !intersects(config.allowedDeviceVerdicts, deviceVerdicts)) {
    throw new AttestationError(
      "Play Integrity device integrity requirements not met",
      401,
      "PLAY_INTEGRITY_DEVICE_NOT_TRUSTED"
    );
  }

  if (config.requirePlayRecognized) {
    const appVerdict = String(verdict.appIntegrity?.appRecognitionVerdict ?? "").trim();
    if (appVerdict !== "PLAY_RECOGNIZED") {
      throw new AttestationError(
        "Play Integrity app not recognized",
        401,
        "PLAY_INTEGRITY_APP_NOT_RECOGNIZED"
      );
    }
  }

  if (config.requireLicensed) {
    const licensing = String(verdict.accountDetails?.appLicensingVerdict ?? "").trim();
    if (licensing !== "LICENSED") {
      throw new AttestationError(
        "Play Integrity licensing requirement not met",
        401,
        "PLAY_INTEGRITY_NOT_LICENSED"
      );
    }
  }

  const expectedNonce = (opts.expectedNonce ?? "").trim();
  if (expectedNonce) {
    const actualNonce = String(verdict.requestDetails?.nonce ?? "").trim();
    if (!actualNonce) {
      throw new AttestationError(
        "Play Integrity verdict missing nonce",
        401,
        "PLAY_INTEGRITY_NO_NONCE"
      );
    }
    if (actualNonce !== expectedNonce) {
      throw new AttestationError(
        "Play Integrity nonce mismatch",
        401,
        "PLAY_INTEGRITY_NONCE_MISMATCH"
      );
    }
  }

  return {
    attested: true,
    attestation: {
      platform: "android",
      // Play Integrity does not provide a stable per-device identifier.
      // We store a short hint for correlation without persisting the token.
      deviceId: verdict.requestDetails?.nonce
        ? `nonce:${String(verdict.requestDetails.nonce).slice(0, 16)}`
        : "play-integrity",
      issuedAt: new Date(timestampMs).toISOString(),
      riskLevel: "low",
    },
  };
}
