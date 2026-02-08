import type { Request } from "express";
import { prisma } from "../prisma";
import type { Prisma } from "@prisma/client";

const SENSITIVE_KEY = /(password|pass|pwd|token|secret|jwt|authorization|cookie|set-cookie|stripe|clientsecret|webhooksecret)/i;
const SENSITIVE_VALUE = /^(Bearer\s+.+|sk_(live|test)_.+|whsec_.+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/;

export type SecurityEventMetadata = Record<string, unknown>;

function getClientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  const fromXff = Array.isArray(xff) ? xff[0] : xff;
  if (typeof fromXff === "string" && fromXff.trim()) {
    // first hop
    const first = fromXff.split(",")[0]?.trim();
    if (first) return first;
  }

  const ip = (req as any).ip;
  if (typeof ip === "string" && ip.trim()) return ip;

  return null;
}

function scrubUnknown(value: unknown, depth: number): unknown {
  if (depth <= 0) return "[TRUNCATED]";

  if (value == null) return value;

  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) return "[REDACTED]";
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    if (value.length > 200) return value.slice(0, 200).map((v) => scrubUnknown(v, depth - 1));
    return value.map((v) => scrubUnknown(v, depth - 1));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    const keys = Object.keys(obj);
    const limitedKeys = keys.length > 200 ? keys.slice(0, 200) : keys;

    for (const key of limitedKeys) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = scrubUnknown(obj[key], depth - 1);
    }

    if (keys.length > limitedKeys.length) {
      out.__truncatedKeys = true;
      out.__originalKeyCount = keys.length;
    }

    return out;
  }

  return "[UNSERIALIZABLE]";
}

export function scrubSecurityMetadata(metadata: unknown): Prisma.InputJsonValue | null {
  const scrubbed = scrubUnknown(metadata, 6) as any;

  try {
    const json = JSON.stringify(scrubbed);
    if (json.length <= 20_000) return scrubbed as Prisma.InputJsonValue;

    if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
      const keys = Object.keys(scrubbed as any);
      return {
        __truncated: true,
        __reason: "metadata_too_large",
        __keys: keys.slice(0, 100),
        __keyCount: keys.length,
      } as Prisma.InputJsonValue;
    }

    return { __truncated: true, __reason: "metadata_too_large" } as Prisma.InputJsonValue;
  } catch {
    return { __truncated: true, __reason: "metadata_unserializable" } as Prisma.InputJsonValue;
  }
}

function pickReserved(metadata: SecurityEventMetadata) {
  const reserved = {
    actorUserId: metadata.actorUserId,
    actorRole: metadata.actorRole,
    actorEmail: metadata.actorEmail,
    targetType: metadata.targetType,
    targetId: metadata.targetId,
  };

  const cleaned: SecurityEventMetadata = { ...metadata };
  delete cleaned.actorUserId;
  delete cleaned.actorRole;
  delete cleaned.actorEmail;
  delete cleaned.targetType;
  delete cleaned.targetId;

  return { reserved, cleaned };
}

/**
 * Best-effort security/audit event logging.
 *
 * Reserved metadata keys (stored in dedicated columns and removed from metadataJson):
 * - actorUserId, actorRole, actorEmail, targetType, targetId
 */
export async function logSecurityEvent(
  req: Request,
  actionType: string,
  metadata: SecurityEventMetadata = {}
): Promise<void> {
  try {
    const requestId = (req as any).requestId ?? (req as any).id;
    const withCorrelation: SecurityEventMetadata =
      requestId && typeof metadata?.requestId !== "string" ? { ...metadata, requestId } : metadata;

    const { reserved, cleaned } = pickReserved(withCorrelation);

    const actorUserId =
      typeof reserved.actorUserId === "number"
        ? reserved.actorUserId
        : req.user?.userId ?? null;

    const actorRole =
      typeof reserved.actorRole === "string"
        ? (reserved.actorRole as any)
        : req.user?.role ?? null;

    const actorEmail = typeof reserved.actorEmail === "string" ? reserved.actorEmail : null;

    const targetType = typeof reserved.targetType === "string" ? reserved.targetType : null;
    const targetIdRaw = reserved.targetId;
    const targetId =
      typeof targetIdRaw === "string"
        ? targetIdRaw
        : typeof targetIdRaw === "number"
          ? String(targetIdRaw)
          : null;

    const metadataJson = scrubSecurityMetadata(cleaned);

    await prisma.securityEvent.create({
      data: {
        actionType,
        actorUserId,
        actorRole,
        actorEmail,
        targetType,
        targetId,
        ip: getClientIp(req),
        userAgent: String(req.headers["user-agent"] ?? "") || null,
        metadataJson,
      },
    });
  } catch (e: any) {
    // best-effort only
    console.warn("[securityEvent] failed to write", {
      actionType,
      error: String(e?.message ?? e),
    });
  }
}
