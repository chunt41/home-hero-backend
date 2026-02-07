import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { assertValidStorageKey, type StorageProvider } from "./storageProvider";

export type S3ProviderConfig = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle?: boolean;
};

function trimOrEmpty(v: unknown): string {
  return String(v ?? "").trim();
}

export function validateS3ConfigOrThrow(cfg: Partial<S3ProviderConfig>) {
  const missing: string[] = [];
  if (!trimOrEmpty(cfg.bucket)) missing.push("OBJECT_STORAGE_S3_BUCKET");
  if (!trimOrEmpty(cfg.region)) missing.push("OBJECT_STORAGE_S3_REGION");
  if (!trimOrEmpty(cfg.accessKeyId)) missing.push("OBJECT_STORAGE_S3_ACCESS_KEY_ID");
  if (!trimOrEmpty(cfg.secretAccessKey)) missing.push("OBJECT_STORAGE_S3_SECRET_ACCESS_KEY");

  if (missing.length) {
    throw new Error(`Missing required S3 env vars: ${missing.join(", ")}`);
  }
}

export function createS3StorageProvider(cfg: S3ProviderConfig): StorageProvider {
  validateS3ConfigOrThrow(cfg);

  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  return {
    async putObject(key: string, buffer: Buffer, contentType: string) {
      assertValidStorageKey(key);
      const ct = String(contentType ?? "application/octet-stream").trim() || "application/octet-stream";
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: buffer,
          ContentType: ct,
        })
      );
    },

    async getSignedReadUrl(key: string, ttlSeconds: number) {
      assertValidStorageKey(key);
      const expiresIn = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor(Number(ttlSeconds) || 0)));
      const cmd = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      });
      return getSignedUrl(client, cmd, { expiresIn });
    },

    async deleteObject(key: string) {
      assertValidStorageKey(key);
      await client.send(
        new DeleteObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
        })
      );
    },
  };
}
