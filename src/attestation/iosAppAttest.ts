import fetch from "node-fetch";
import { AttestationError } from "./attestationError";

export type IosAppAttestTokenClaims = {
  bundleId: string;
  keyId: string;
  timestampMs: number;
  nonce?: string;
  // Opaque payloads from the device (base64 strings) if you choose to send them.
  attestationObjectB64?: string;
  assertionB64?: string;
  [k: string]: unknown;
};

export type IosAppAttestProviderVerifyInput = {
  token: string;
  claims: IosAppAttestTokenClaims;
};

export type IosAppAttestProviderVerifyOutput = {
  verified: boolean;
  failureCode?: string;
  // Optional enriched fields for analytics.
  deviceIdHint?: string;
};

/**
 * Provider interface isolating the hard crypto / Apple-facing verification.
 *
 * Why: Full App Attest verification can require parsing CBOR, validating X.509 chains,
 * and verifying assertions. This interface lets you swap in a full verifier later
 * without changing the middleware.
 */
export type IosAppAttestProvider = {
  verify(input: IosAppAttestProviderVerifyInput): Promise<IosAppAttestProviderVerifyOutput>;
};

export type VerifyIosAppAttestOptions = {
  expectedNonce?: string;
  nowMs?: number;
  provider?: IosAppAttestProvider;
  fetchImpl?: typeof fetch;
};

function parseCommaList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function requireFreshTimestamp(tsMs: number, nowMs: number, maxAgeMs: number, maxFutureSkewMs: number) {
  if (!Number.isFinite(tsMs) || tsMs <= 0) {
    throw new AttestationError("iOS attestation missing timestamp", 401, "IOS_ATTEST_NO_TIMESTAMP");
  }

  if (tsMs > nowMs + maxFutureSkewMs) {
    throw new AttestationError(
      "iOS attestation timestamp is in the future",
      401,
      "IOS_ATTEST_TIMESTAMP_FUTURE"
    );
  }

  const age = nowMs - tsMs;
  if (age > maxAgeMs) {
    throw new AttestationError("iOS attestation is too old", 401, "IOS_ATTEST_STALE");
  }
}

function decodeBase64UrlJson(token: string): any {
  // Token is expected to be base64url(JSON) (single segment) OR a JWT (3 segments)
  // where payload is JSON.
  const trimmed = token.trim();
  const parts = trimmed.split(".");

  const payloadB64Url = parts.length === 3 ? parts[1] : parts.length === 1 ? parts[0] : null;
  if (!payloadB64Url) {
    throw new AttestationError("Invalid iOS attestation token format", 401, "IOS_ATTEST_FORMAT");
  }

  const b64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const buf = Buffer.from(b64 + pad, "base64");
  const text = buf.toString("utf8");

  try {
    return JSON.parse(text);
  } catch {
    throw new AttestationError("Invalid iOS attestation token payload", 401, "IOS_ATTEST_BAD_PAYLOAD");
  }
}

function parseClaims(token: string): IosAppAttestTokenClaims {
  const payload = decodeBase64UrlJson(token);

  const bundleId = String(payload?.bundleId ?? payload?.bundleID ?? payload?.appId ?? "").trim();
  const keyId = String(payload?.keyId ?? payload?.keyID ?? payload?.kid ?? "").trim();
  const timestampMsRaw = payload?.timestampMs ?? payload?.timestampMillis ?? payload?.ts;
  const timestampMs = typeof timestampMsRaw === "number" ? timestampMsRaw : Number(String(timestampMsRaw ?? ""));
  const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : undefined;

  if (!bundleId) {
    throw new AttestationError("iOS attestation missing bundle id", 401, "IOS_ATTEST_NO_BUNDLE");
  }
  if (!keyId) {
    throw new AttestationError("iOS attestation missing key id", 401, "IOS_ATTEST_NO_KEY_ID");
  }

  return {
    bundleId,
    keyId,
    timestampMs,
    nonce,
    attestationObjectB64: typeof payload?.attestationObjectB64 === "string" ? payload.attestationObjectB64 : undefined,
    assertionB64: typeof payload?.assertionB64 === "string" ? payload.assertionB64 : undefined,
  };
}

function getIosPolicyFromEnv() {
  /**
   * Required env vars (iOS policy):
   * - IOS_APP_ATTEST_BUNDLE_ID: expected iOS bundle identifier
   * - IOS_APP_ATTEST_ALLOWED_KEY_IDS: comma-separated allowlist of key IDs (or set to "*" to allow any)
   *
   * Optional env vars:
   * - IOS_APP_ATTEST_MAX_TOKEN_AGE_SECONDS: freshness window (default 300)
   * - IOS_APP_ATTEST_MAX_FUTURE_SKEW_SECONDS: allow small future skew (default 60)
   *
   * Provider plumbing (for full verification):
   * - IOS_APP_ATTEST_VERIFY_URL: if set, the default provider will POST here to verify
   * - IOS_APP_ATTEST_VERIFY_AUTH_HEADER: optional static Authorization header value for that service
   */
  const expectedBundleId = String(process.env.IOS_APP_ATTEST_BUNDLE_ID ?? "").trim();
  if (!expectedBundleId) {
    throw new AttestationError(
      "iOS attestation verification is not configured (missing IOS_APP_ATTEST_BUNDLE_ID)",
      503,
      "IOS_ATTEST_NOT_CONFIGURED"
    );
  }

  const allowedKeyIdsRaw = String(process.env.IOS_APP_ATTEST_ALLOWED_KEY_IDS ?? "").trim();
  const allowAnyKeyId = allowedKeyIdsRaw === "*";
  const allowedKeyIds = allowAnyKeyId ? [] : parseCommaList(allowedKeyIdsRaw);
  if (!allowAnyKeyId && !allowedKeyIds.length) {
    throw new AttestationError(
      "iOS attestation verification is not configured (missing IOS_APP_ATTEST_ALLOWED_KEY_IDS)",
      503,
      "IOS_ATTEST_NOT_CONFIGURED"
    );
  }

  const maxAgeMs = envInt("IOS_APP_ATTEST_MAX_TOKEN_AGE_SECONDS", 300) * 1000;
  const maxFutureSkewMs = envInt("IOS_APP_ATTEST_MAX_FUTURE_SKEW_SECONDS", 60) * 1000;

  return { expectedBundleId, allowedKeyIds, allowAnyKeyId, maxAgeMs, maxFutureSkewMs };
}

function defaultProvider(fetchImpl: typeof fetch): IosAppAttestProvider {
  const url = String(process.env.IOS_APP_ATTEST_VERIFY_URL ?? "").trim();
  const authHeader = String(process.env.IOS_APP_ATTEST_VERIFY_AUTH_HEADER ?? "").trim();
  return {
    async verify({ token, claims }) {
      if (!url) {
        throw new AttestationError(
          "iOS attestation provider not configured (missing IOS_APP_ATTEST_VERIFY_URL)",
          503,
          "IOS_ATTEST_PROVIDER_NOT_CONFIGURED"
        );
      }

      const resp = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        // Do not include server secrets; token is already provided by client.
        body: JSON.stringify({ token, claims }),
      });

      if (!resp.ok) {
        throw new AttestationError(
          `iOS attestation provider error (${resp.status})`,
          401,
          "IOS_ATTEST_PROVIDER_ERROR"
        );
      }

      const json = (await resp.json()) as any;
      const verified = Boolean(json?.verified);
      return {
        verified,
        failureCode: typeof json?.failureCode === "string" ? json.failureCode : undefined,
        deviceIdHint: typeof json?.deviceIdHint === "string" ? json.deviceIdHint : undefined,
      };
    },
  };
}

export async function verifyIosAppAttestAttestation(
  token: string,
  opts: VerifyIosAppAttestOptions = {}
): Promise<{
  attested: true;
  attestation: {
    platform: "ios";
    deviceId: string;
    issuedAt: string;
    riskLevel: "low";
  };
}> {
  if (typeof token !== "string" || !token.trim()) {
    throw new AttestationError("Missing iOS attestation token", 401, "IOS_ATTEST_MISSING_TOKEN");
  }

  const policy = getIosPolicyFromEnv();
  const nowMs = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();

  const claims = parseClaims(token);

  if (claims.bundleId !== policy.expectedBundleId) {
    throw new AttestationError("iOS bundle id mismatch", 401, "IOS_ATTEST_BUNDLE_MISMATCH");
  }

  if (!policy.allowAnyKeyId && !policy.allowedKeyIds.includes(claims.keyId)) {
    throw new AttestationError("iOS key id not allowed", 401, "IOS_ATTEST_KEY_ID_NOT_ALLOWED");
  }

  requireFreshTimestamp(claims.timestampMs, nowMs, policy.maxAgeMs, policy.maxFutureSkewMs);

  const expectedNonce = (opts.expectedNonce ?? "").trim();
  if (expectedNonce) {
    if (!claims.nonce) {
      throw new AttestationError("iOS attestation missing nonce", 401, "IOS_ATTEST_NO_NONCE");
    }
    if (claims.nonce !== expectedNonce) {
      throw new AttestationError("iOS nonce mismatch", 401, "IOS_ATTEST_NONCE_MISMATCH");
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider = opts.provider ?? defaultProvider(fetchImpl);
  const providerResult = await provider.verify({ token, claims });

  if (!providerResult.verified) {
    throw new AttestationError(
      "iOS attestation provider rejected token",
      401,
      providerResult.failureCode || "IOS_ATTEST_PROVIDER_REJECTED"
    );
  }

  return {
    attested: true,
    attestation: {
      platform: "ios",
      deviceId: providerResult.deviceIdHint ? `ios:${providerResult.deviceIdHint}` : `key:${claims.keyId}`,
      issuedAt: new Date(claims.timestampMs).toISOString(),
      riskLevel: "low",
    },
  };
}
