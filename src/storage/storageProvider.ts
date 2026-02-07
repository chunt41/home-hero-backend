export type PutObjectInput = {
  key: string;
  buffer: Buffer;
  contentType: string;
};

export interface StorageProvider {
  putObject(key: string, buffer: Buffer, contentType: string): Promise<void>;
  getSignedReadUrl(key: string, ttlSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export function assertValidStorageKey(key: string) {
  const k = String(key ?? "").trim();
  if (!k) throw new Error("storage key is required");
  if (k.startsWith("/")) throw new Error("storage key must not start with '/'");
  if (k.includes("..")) throw new Error("storage key must not contain '..'");
}
