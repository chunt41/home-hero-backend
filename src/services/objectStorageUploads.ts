import * as path from "node:path";

import type { StorageProvider } from "../storage/storageProvider";

export type UploadNamespace = "job" | "message" | "verification";

export function computeNewUploadTargets(params: {
  namespace: UploadNamespace;
  ownerId: number | string;
  basename: string;
  storageProvider?: StorageProvider;
  nodeEnv?: string;
}): { storageKey: string | null; diskPath: string | null } {
  const nodeEnv = (params.nodeEnv ?? process.env.NODE_ENV ?? "development").trim() || "development";

  if (nodeEnv === "production" && !params.storageProvider) {
    throw new Error("Attachment storage is not configured for production.");
  }

  if (params.storageProvider) {
    return {
      storageKey: path.posix.join("attachments", params.namespace, String(params.ownerId), params.basename),
      diskPath: null,
    };
  }

  // Dev-only fallback: store on disk.
  return {
    storageKey: null,
    diskPath: path.posix.join("attachments", params.basename),
  };
}
