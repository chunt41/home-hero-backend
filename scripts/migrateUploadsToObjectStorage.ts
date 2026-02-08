import * as fs from "node:fs";
import * as path from "node:path";

import { prisma } from "../src/prisma";
import { resolveDiskPathInsideUploadsDir } from "../src/utils/attachmentsGuard";
import { getStorageProviderOrThrow } from "../src/storage/storageFactory";

type Flags = {
  dryRun: boolean;
  limit: number | null;
  concurrency: number;
  help: boolean;
};

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    dryRun: false,
    limit: null,
    concurrency: 5,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") flags.help = true;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      flags.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } else if (arg.startsWith("--concurrency=")) {
      const n = Number(arg.slice("--concurrency=".length));
      flags.concurrency = Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
    }
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/migrateUploadsToObjectStorage.ts [--dry-run] [--limit=<n>] [--concurrency=<n>]

Migrates legacy disk-backed attachment rows (diskPath) into object storage (storageKey).

Flags:
  --dry-run            Do not upload or write DB updates; only log intended actions
  --limit=<n>          Stop after migrating <n> rows (across all attachment tables)
  --concurrency=<n>    Parallelism for uploads/updates (default: 5)
  -h, --help           Show this help
`);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const limit = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 5;
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function sanitizeFilenameForStorageKey(filename: string): string {
  const base = path.posix.basename(String(filename || "file")).trim() || "file";
  // Keep a conservative set of characters.
  const cleaned = base
    .replace(/\\/g, "_")
    .replace(/\//g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  // Avoid empty result.
  return cleaned || "file";
}

function makeDeterministicStorageKey(args: {
  namespace: "job" | "message" | "verification";
  id: number;
  filename: string;
}): string {
  const safeName = sanitizeFilenameForStorageKey(args.filename);
  return path.posix.join("attachments", args.namespace, String(args.id), safeName);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  const storage = getStorageProviderOrThrow();

  const uploadsDir = path.join(process.cwd(), "uploads");

  console.log("[migrate] starting", {
    dryRun: flags.dryRun,
    limit: flags.limit,
    concurrency: flags.concurrency,
    uploadsDir,
  });

  let migrated = 0;
  let failed = 0;
  let processed = 0;
  let skippedMissingFile = 0;
  let skippedInvalidPath = 0;
  let skippedNoDiskPath = 0;

  async function maybeStop() {
    if (flags.limit !== null && migrated >= flags.limit) {
      console.log("[migrate] reached limit, stopping", { migrated });
      process.exit(0);
    }
  }

  function logProgress() {
    // best-effort periodic progress logging
    if (processed > 0 && processed % 25 === 0) {
      console.log("[migrate] progress", {
        processed,
        migrated,
        failed,
        skippedMissingFile,
        skippedInvalidPath,
        skippedNoDiskPath,
      });
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
          filename: true,
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      await mapWithConcurrency(rows, flags.concurrency, async (row) => {
        processed += 1;
        logProgress();

        if (!row.diskPath) {
          skippedNoDiskPath += 1;
          return;
        }

        try {
          let abs: string;
          try {
            abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
          } catch {
            skippedInvalidPath += 1;
            return;
          }

          if (!(await fileExists(abs))) {
            skippedMissingFile += 1;
            console.warn("[migrate] missing_file", { kind: "job", id: row.id, diskPath: row.diskPath });
            return;
          }

          const filename = row.filename || path.posix.basename(row.diskPath);
          const storageKey = makeDeterministicStorageKey({
            namespace: "job",
            id: row.id,
            filename,
          });

          if (!flags.dryRun) {
            const buf = await fs.promises.readFile(abs);
            const ct = row.mimeType || "application/octet-stream";
            await storage.putObject(storageKey, buf, ct);

            await prisma.jobAttachment.update({
              where: { id: row.id },
              data: {
                storageKey,
                // Keep diskPath for rollback.
              },
            });
          }

          migrated += 1;
          await maybeStop();
        } catch (e: any) {
          failed += 1;
          console.error("[migrate] job_attachment_failed", {
            id: row.id,
            diskPath: row.diskPath,
            message: String(e?.message ?? e),
          });
        }
      });
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
          filename: true,
          message: { select: { jobId: true } },
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      await mapWithConcurrency(rows, flags.concurrency, async (row) => {
        processed += 1;
        logProgress();

        if (!row.diskPath) {
          skippedNoDiskPath += 1;
          return;
        }

        try {
          let abs: string;
          try {
            abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
          } catch {
            skippedInvalidPath += 1;
            return;
          }

          if (!(await fileExists(abs))) {
            skippedMissingFile += 1;
            console.warn("[migrate] missing_file", { kind: "message", id: row.id, diskPath: row.diskPath });
            return;
          }

          const filename = row.filename || path.posix.basename(row.diskPath);
          const storageKey = makeDeterministicStorageKey({
            namespace: "message",
            id: row.id,
            filename,
          });

          if (!flags.dryRun) {
            const buf = await fs.promises.readFile(abs);
            const ct = row.mimeType || "application/octet-stream";
            await storage.putObject(storageKey, buf, ct);

            await prisma.messageAttachment.update({
              where: { id: row.id },
              data: {
                storageKey,
                // Keep diskPath for rollback.
              },
            });
          }

          migrated += 1;
          await maybeStop();
        } catch (e: any) {
          failed += 1;
          console.error("[migrate] message_attachment_failed", {
            id: row.id,
            diskPath: row.diskPath,
            message: String(e?.message ?? e),
          });
        }
      });
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
          filename: true,
        },
      });

      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      await mapWithConcurrency(rows, flags.concurrency, async (row) => {
        processed += 1;
        logProgress();

        if (!row.diskPath) {
          skippedNoDiskPath += 1;
          return;
        }

        try {
          let abs: string;
          try {
            abs = resolveDiskPathInsideUploadsDir(uploadsDir, row.diskPath);
          } catch {
            skippedInvalidPath += 1;
            return;
          }

          if (!(await fileExists(abs))) {
            skippedMissingFile += 1;
            console.warn("[migrate] missing_file", {
              kind: "verification",
              id: row.id,
              diskPath: row.diskPath,
            });
            return;
          }

          const filename = row.filename || path.posix.basename(row.diskPath);
          const storageKey = makeDeterministicStorageKey({
            namespace: "verification",
            id: row.id,
            filename,
          });

          if (!flags.dryRun) {
            const buf = await fs.promises.readFile(abs);
            const ct = row.mimeType || "application/octet-stream";
            await storage.putObject(storageKey, buf, ct);

            await prisma.providerVerificationAttachment.update({
              where: { id: row.id },
              data: {
                storageKey,
                // Keep diskPath for rollback.
              },
            });
          }

          migrated += 1;
          await maybeStop();
        } catch (e: any) {
          failed += 1;
          console.error("[migrate] verification_attachment_failed", {
            id: row.id,
            diskPath: row.diskPath,
            message: String(e?.message ?? e),
          });
        }
      });
    }
  }

  await migrateJobAttachments();
  await migrateMessageAttachments();
  await migrateVerificationAttachments();

  console.log("[migrate] done", {
    processed,
    migrated,
    failed,
    skippedMissingFile,
    skippedInvalidPath,
    skippedNoDiskPath,
  });

  if (failed > 0) {
    // Non-zero exit code for visibility in CI/ops, but we still processed everything.
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("[migrate] failed", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
