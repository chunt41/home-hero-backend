import * as fs from "node:fs";
import * as path from "node:path";

import { prisma } from "../src/prisma";
import { resolveDiskPathInsideUploadsDir } from "../src/utils/attachmentsGuard";
import {
  getObjectStorageProviderName,
  getStorageProviderOrThrow,
} from "../src/storage/storageFactory";

type Flags = {
  dryRun: boolean;
  clearDiskPath: boolean;
  deleteLocal: boolean;
  limit: number | null;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    dryRun: false,
    clearDiskPath: false,
    deleteLocal: false,
    limit: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--clear-disk-path") flags.clearDiskPath = true;
    else if (arg === "--delete-local") flags.deleteLocal = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      flags.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
  }

  if (flags.deleteLocal) flags.clearDiskPath = true;
  return flags;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  const providerName = getObjectStorageProviderName();
  if (providerName !== "s3") {
    throw new Error(
      "This migration requires OBJECT_STORAGE_PROVIDER=s3 (S3/R2 compatible)."
    );
  }

  const storage = getStorageProviderOrThrow();

  const uploadsDir = path.join(process.cwd(), "uploads");

  console.log("[migrate] starting", {
    dryRun: flags.dryRun,
    clearDiskPath: flags.clearDiskPath,
    deleteLocal: flags.deleteLocal,
    limit: flags.limit,
    uploadsDir,
  });

  let migrated = 0;
  let skippedMissingFile = 0;
  let skippedInvalidPath = 0;

  async function maybeStop() {
    if (flags.limit !== null && migrated >= flags.limit) {
      console.log("[migrate] reached limit, stopping", { migrated });
      process.exit(0);
    }
  }

  async function migrateJobAttachments() {
    console.log("[migrate] job attachments...");

    const batchSize = 100;
    let lastId = 0;

    while (true) {
      const rows = await prisma.jobAttachment.findMany({
        where: {
          id: { gt: lastId },
          storageKey: null,
          diskPath: { not: null },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: {
          id: true,
          jobId: true,
          diskPath: true,
          mimeType: true,
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      for (const row of rows) {
        if (!row.diskPath) continue;

        let abs: string;
        try {
          abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
        } catch {
          skippedInvalidPath += 1;
          continue;
        }

        if (!(await fileExists(abs))) {
          skippedMissingFile += 1;
          continue;
        }

        const basename = path.posix.basename(row.diskPath);
        const storageKey = path.posix.join(
          "attachments",
          "job",
          String(row.jobId),
          basename
        );

        if (!flags.dryRun) {
          const buf = await fs.promises.readFile(abs);
          const ct = row.mimeType || "application/octet-stream";

          await storage.putObject(storageKey, buf, ct);

          await prisma.jobAttachment.update({
            where: { id: row.id },
            data: {
              storageKey,
              ...(flags.clearDiskPath ? { diskPath: null } : {}),
            },
          });

          if (flags.deleteLocal) {
            await fs.promises.unlink(abs).catch(() => null);
          }
        }

        migrated += 1;
        await maybeStop();
      }
    }
  }

  async function migrateMessageAttachments() {
    console.log("[migrate] message attachments...");

    const batchSize = 100;
    let lastId = 0;

    while (true) {
      const rows = await prisma.messageAttachment.findMany({
        where: {
          id: { gt: lastId },
          storageKey: null,
          diskPath: { not: null },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: {
          id: true,
          diskPath: true,
          mimeType: true,
          message: { select: { jobId: true } },
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      for (const row of rows) {
        if (!row.diskPath) continue;

        let abs: string;
        try {
          abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
        } catch {
          skippedInvalidPath += 1;
          continue;
        }

        if (!(await fileExists(abs))) {
          skippedMissingFile += 1;
          continue;
        }

        const basename = path.posix.basename(row.diskPath);
        const storageKey = path.posix.join(
          "attachments",
          "message",
          String(row.message.jobId),
          basename
        );

        if (!flags.dryRun) {
          const buf = await fs.promises.readFile(abs);
          const ct = row.mimeType || "application/octet-stream";

          await storage.putObject(storageKey, buf, ct);

          await prisma.messageAttachment.update({
            where: { id: row.id },
            data: {
              storageKey,
              ...(flags.clearDiskPath ? { diskPath: null } : {}),
            },
          });

          if (flags.deleteLocal) {
            await fs.promises.unlink(abs).catch(() => null);
          }
        }

        migrated += 1;
        await maybeStop();
      }
    }
  }

  async function migrateVerificationAttachments() {
    console.log("[migrate] provider verification attachments...");

    const batchSize = 100;
    let lastId = 0;

    while (true) {
      const rows = await prisma.providerVerificationAttachment.findMany({
        where: {
          id: { gt: lastId },
          storageKey: null,
          diskPath: { not: null },
        },
        orderBy: { id: "asc" },
        take: batchSize,
        select: {
          id: true,
          providerId: true,
          diskPath: true,
          mimeType: true,
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      for (const row of rows) {
        if (!row.diskPath) continue;

        let abs: string;
        try {
          abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
        } catch {
          skippedInvalidPath += 1;
          continue;
        }

        if (!(await fileExists(abs))) {
          skippedMissingFile += 1;
          continue;
        }

        const basename = path.posix.basename(row.diskPath);
        const storageKey = path.posix.join(
          "attachments",
          "verification",
          String(row.providerId),
          basename
        );

        if (!flags.dryRun) {
          const buf = await fs.promises.readFile(abs);
          const ct = row.mimeType || "application/octet-stream";

          await storage.putObject(storageKey, buf, ct);

          await prisma.providerVerificationAttachment.update({
            where: { id: row.id },
            data: {
              storageKey,
              ...(flags.clearDiskPath ? { diskPath: null } : {}),
            },
          });

          if (flags.deleteLocal) {
            await fs.promises.unlink(abs).catch(() => null);
          }
        }

        migrated += 1;
        await maybeStop();
      }
    }
  }

  await migrateJobAttachments();
  await migrateMessageAttachments();
  await migrateVerificationAttachments();

  console.log("[migrate] done", {
    migrated,
    skippedMissingFile,
    skippedInvalidPath,
  });
}

main()
  .catch((e) => {
    console.error("[migrate] failed", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
