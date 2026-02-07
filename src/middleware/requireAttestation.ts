import type { NextFunction, Request, Response } from "express";
import * as jwt from "jsonwebtoken";

import { logSecurityEvent } from "../services/securityEventLogger";
import {
  verifyAndroidPlayIntegrityAttestation,
} from "../attestation/androidPlayIntegrity";
import { verifyIosAppAttestAttestation } from "../attestation/iosAppAttest";
import { AttestationError } from "../attestation/attestationError";

export type AttestationInfo = {
  platform: "android" | "ios" | "unknown";
  deviceId: string;
  issuedAt: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
};

export type AttestationResult = {
  attested: true;
  attestation: AttestationInfo;
};

export type AttestationVerifier = {
  verify(token: string): Promise<AttestationResult>;
};

function allowUnattestedDev(): boolean {
  const flag = String(process.env.ALLOW_UNATTESTED_DEV ?? "").toLowerCase() === "true";
  const isProd = process.env.NODE_ENV === "production";
  return flag && !isProd;
}

function enforceAttestation(): boolean {
  return String(process.env.APP_ATTESTATION_ENFORCE ?? "").toLowerCase() === "true";
}

function normalizeToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Support either raw JWT or "Bearer <jwt>"
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    const rest = trimmed.slice("bearer ".length).trim();
    return rest || null;
  }

  return trimmed;
}

function headerPlatform(req: Request): AttestationInfo["platform"] {
  // Clients should send X-App-Platform: android|ios
  return asPlatform(req.header("X-App-Platform"));
}

function isLikelyJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function parsePublicKeysFromEnv(): { defaultKey?: string; keysByKid?: Record<string, string> } {
  const json = (process.env.APP_ATTESTATION_PUBLIC_KEYS_JSON ?? "").trim();
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object") {
        return { keysByKid: parsed as Record<string, string> };
      }
    } catch {
      // ignore
    }
  }

  const pem = (process.env.APP_ATTESTATION_PUBLIC_KEY_PEM ?? "").trim();
  if (pem) {
    return { defaultKey: pem };
  }

  return {};
}

function pickKey(token: string): { key: string; kid?: string } {
  const { defaultKey, keysByKid } = parsePublicKeysFromEnv();

  if (keysByKid && Object.keys(keysByKid).length) {
    const decoded = jwt.decode(token, { complete: true }) as any;
    const kid = decoded?.header?.kid ? String(decoded.header.kid) : undefined;
    const k = (kid && keysByKid[kid]) || undefined;
    if (!k) {
      throw new AttestationError("Attestation key id not recognized", 401, "ATTESTATION_KID_UNKNOWN");
    }
    return { key: k, kid };
  }

  if (defaultKey) {
    return { key: defaultKey };
  }

  throw new AttestationError(
    "Attestation verification is not configured on this server",
    503,
    "ATTESTATION_NOT_CONFIGURED"
  );
}

function asPlatform(v: unknown): AttestationInfo["platform"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "android") return "android";
  if (s === "ios") return "ios";
  return "unknown";
}

function asRiskLevel(v: unknown): AttestationInfo["riskLevel"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s as any;
  return "unknown";
}

/**
 * Stub verifier (JWT + env public keys).
 *
 * Where to plug real verification later:
 * - Android: verify Play Integrity JWS, check nonce, package name, certificate digest.
 * - iOS: verify App Attest / DeviceCheck assertions and bind to your app + device.
 *
 * For now we only:
 * - validate JWT format
 * - validate signature using env public keys
 * - validate exp/iat
 * - extract a few fields into req.attestation
 */
export function createAttestationVerifier(): AttestationVerifier {
  return {
    async verify(token: string) {
      if (!isLikelyJwt(token)) {
        throw new AttestationError("Invalid attestation token format", 401, "ATTESTATION_FORMAT");
      }

      const { key } = pickKey(token);
      const alg = String(process.env.APP_ATTESTATION_JWT_ALG ?? "RS256") as jwt.Algorithm;

      const issuer = (process.env.APP_ATTESTATION_ISSUER ?? "").trim() || undefined;
      const audience = (process.env.APP_ATTESTATION_AUDIENCE ?? "").trim() || undefined;

      let payload: any;
      try {
        payload = jwt.verify(token, key, {
          algorithms: [alg],
          issuer,
          audience,
          clockTolerance: 30,
        });
      } catch (e: any) {
        const msg = String(e?.message || "Attestation verification failed");
        throw new AttestationError(msg, 401, "ATTESTATION_VERIFY");
      }

      const exp = Number(payload?.exp);
      const iat = Number(payload?.iat);
      if (!Number.isFinite(exp) || exp <= 0) {
        throw new AttestationError("Attestation token missing exp", 401, "ATTESTATION_NO_EXP");
      }
      if (!Number.isFinite(iat) || iat <= 0) {
        throw new AttestationError("Attestation token missing iat", 401, "ATTESTATION_NO_IAT");
      }

      const deviceId = String(payload?.deviceId ?? payload?.sub ?? "").trim();
      if (!deviceId) {
        throw new AttestationError("Attestation token missing device identifier", 401, "ATTESTATION_NO_DEVICE");
      }

      const result: AttestationResult = {
        attested: true,
        attestation: {
          platform: asPlatform(payload?.platform ?? payload?.plat),
          deviceId,
          issuedAt: new Date(iat * 1000).toISOString(),
          riskLevel: asRiskLevel(payload?.riskLevel ?? payload?.risk),
        },
      };

      return result;
    },
  };
}

// Simple in-memory failure throttle (best-effort; replace with distributed store if needed)
const failureWindowMs = 60_000;
const maxFailuresPerKey = 25;
const failures = new Map<string, { count: number; resetAt: number }>();

function bumpFailure(key: string): { limited: boolean; remainingMs: number } {
  const now = Date.now();
  const cur = failures.get(key);

  if (!cur || cur.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + failureWindowMs });
    return { limited: false, remainingMs: failureWindowMs };
  }

  cur.count += 1;
  failures.set(key, cur);

  const limited = cur.count > maxFailuresPerKey;
  return { limited, remainingMs: Math.max(0, cur.resetAt - now) };
}

function failureKey(req: Request): string {
  const ip = String((req as any).ip ?? "");
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
  // keep key short; ip-only is fine but UA adds a bit of separation
  return `${ip}|${ua}`;
}

export type AttestationVerifierDeps = {
  verifyAndroid?: typeof verifyAndroidPlayIntegrityAttestation;
  verifyIos?: typeof verifyIosAppAttestAttestation;
  verifyJwt?: (token: string) => Promise<AttestationResult>;
};

export function createRequireAttestation(deps: AttestationVerifierDeps = {}) {
  const verifyAndroid = deps.verifyAndroid ?? verifyAndroidPlayIntegrityAttestation;
  const verifyIos = deps.verifyIos ?? verifyIosAppAttestAttestation;
  const verifyJwt =
    deps.verifyJwt ??
    (async (token: string) => {
      const verifier = createAttestationVerifier();
      return verifier.verify(token);
    });

  return async function requireAttestationMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!enforceAttestation()) {
      (req as any).attested = false;
      return next();
    }

    const platform = headerPlatform(req);
    const raw = req.header("X-App-Attestation");
    const token = normalizeToken(raw);

    if (!token) {
      if (allowUnattestedDev()) {
        (req as any).attested = false;
        return next();
      }

      const { limited, remainingMs } = bumpFailure(failureKey(req));
      if (limited) {
        res.setHeader("Retry-After", String(Math.ceil(remainingMs / 1000)));
        return res.status(429).json({ error: "Too many invalid attestation attempts. Please slow down." });
      }

      console.warn("[attestation] missing token", {
        path: req.path,
        method: req.method,
        ip: (req as any).ip,
        platform,
      });

      void logSecurityEvent(req, "attestation.missing", {
        targetType: "route",
        targetId: req.path,
        platform,
        code: "ATTESTATION_MISSING",
        method: req.method,
      });

      return res.status(401).json({ error: "App attestation required" });
    }

    if (allowUnattestedDev()) {
      // In dev bypass mode, still mark we received something for observability.
      (req as any).attested = false;
      (req as any).attestation = {
        platform: "unknown",
        deviceId: "dev-bypass",
        issuedAt: new Date().toISOString(),
        riskLevel: "unknown",
      } satisfies AttestationInfo;
      return next();
    }

    try {
      let result: AttestationResult;

      // Route verification based on platform header (preferred) and token format (fallback).
      if (platform === "android") {
        const expectedNonce = normalizeToken(req.header("X-App-Attestation-Nonce"));
        result = await verifyAndroid(token, {
          expectedNonce: expectedNonce ?? undefined,
        });
      } else if (platform === "ios") {
        const expectedNonce = normalizeToken(req.header("X-App-Attestation-Nonce"));
        result = await verifyIos(token, {
          expectedNonce: expectedNonce ?? undefined,
        });
      } else {
        // Back-compat: older clients may only send a JWT.
        if (isLikelyJwt(token)) {
          result = await verifyJwt(token);
        } else {
          throw new AttestationError(
            "Unsupported attestation token/platform; send X-App-Platform",
            401,
            "ATTESTATION_UNSUPPORTED"
          );
        }
      }

      (req as any).attested = true;
      (req as any).attestation = result.attestation;
      return next();
    } catch (e: any) {
      const { limited, remainingMs } = bumpFailure(failureKey(req));
      if (limited) {
        res.setHeader("Retry-After", String(Math.ceil(remainingMs / 1000)));
        return res.status(429).json({ error: "Too many invalid attestation attempts. Please slow down." });
      }

      const status = typeof e?.status === "number" ? e.status : 401;
      const message = typeof e?.message === "string" ? e.message : "Invalid attestation";

      console.warn("[attestation] failed", {
        path: req.path,
        method: req.method,
        ip: (req as any).ip,
        platform,
        code: e?.code,
        message,
      });

      void logSecurityEvent(req, "attestation.failed", {
        targetType: "route",
        targetId: req.path,
        platform,
        code: String(e?.code ?? "ATTESTATION_FAILED"),
        method: req.method,
      });

      return res.status(status).json({ error: `App attestation failed: ${message}` });
    }
  };
}

export const requireAttestation = createRequireAttestation();
