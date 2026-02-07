import { env } from "../config/env";
import { createS3StorageProvider } from "./s3Provider";
import type { StorageProvider } from "./storageProvider";

export type ObjectStorageProviderName = "s3" | "disk";

function envBool(name: string, defaultValue = false): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getObjectStorageProviderName(): ObjectStorageProviderName {
  const raw = String(process.env.OBJECT_STORAGE_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "s3") return "s3";
  return "disk";
}

export function validateObjectStorageStartupOrThrow() {
  if ((process.env.NODE_ENV ?? "development") !== "production") return;

  const provider = getObjectStorageProviderName();
  if (provider !== "s3") {
    throw new Error("FATAL: OBJECT_STORAGE_PROVIDER must be 's3' in production.");
  }

  {
    // createS3StorageProvider will validate required env vars.
    createS3StorageProvider({
      bucket: String(process.env.OBJECT_STORAGE_S3_BUCKET ?? ""),
      region: String(process.env.OBJECT_STORAGE_S3_REGION ?? ""),
      accessKeyId: String(process.env.OBJECT_STORAGE_S3_ACCESS_KEY_ID ?? ""),
      secretAccessKey: String(process.env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY ?? ""),
      endpoint: String(process.env.OBJECT_STORAGE_S3_ENDPOINT ?? "") || undefined,
      forcePathStyle: envBool("OBJECT_STORAGE_S3_FORCE_PATH_STYLE", false),
    });
  }
}

export function getStorageProviderOrThrow(): StorageProvider {
  const provider = getObjectStorageProviderName();
  if (provider === "s3") {
    return createS3StorageProvider({
      bucket: String(process.env.OBJECT_STORAGE_S3_BUCKET ?? ""),
      region: String(process.env.OBJECT_STORAGE_S3_REGION ?? ""),
      accessKeyId: String(process.env.OBJECT_STORAGE_S3_ACCESS_KEY_ID ?? ""),
      secretAccessKey: String(process.env.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY ?? ""),
      endpoint: String(process.env.OBJECT_STORAGE_S3_ENDPOINT ?? "") || undefined,
      forcePathStyle: envBool("OBJECT_STORAGE_S3_FORCE_PATH_STYLE", false),
    });
  }

  throw new Error(
    "Object storage provider is not configured. Set OBJECT_STORAGE_PROVIDER=s3."
  );
}

export function getAttachmentSignedUrlTtlSeconds(): number {
  const n = Math.floor(Number(process.env.ATTACHMENTS_SIGNED_URL_TTL_SECONDS ?? 300));
  if (!Number.isFinite(n) || n <= 0) return 300;
  return Math.min(n, 7 * 24 * 60 * 60);
}
