import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createPostJobAttachmentUploadHandler } from "./attachmentUploadHandlers";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("job attachment upload in production uses object storage (no diskPath)", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));

  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = (async () => {
    throw new Error("disk write should not happen in this test");
  }) as any;
  t.after(() => {
    fs.promises.writeFile = originalWriteFile;
  });

  const jobId = 123;
  const consumerId = 456;

  let putCalls = 0;
  let lastPutKey: string | null = null;

  const storageProvider = {
    putObject: async (key: string) => {
      putCalls += 1;
      lastPutKey = key;
    },
    deleteObject: async () => {},
    getSignedReadUrl: async () => "",
  };

  let createdDiskPath: string | null | undefined;
  let createdStorageKey: string | null | undefined;

  const prisma = {
    job: {
      findUnique: async () => ({
        id: jobId,
        consumerId,
        status: "OPEN",
        title: "My Job",
        location: "Somewhere",
      }),
    },
    jobAttachment: {
      create: async (args: any) => {
        createdDiskPath = args?.data?.diskPath;
        createdStorageKey = args?.data?.storageKey;
        return {
          id: 999,
          jobId: args.data.jobId,
          diskPath: args.data.diskPath,
          storageKey: args.data.storageKey,
          type: args.data.type,
          mimeType: args.data.mimeType,
          filename: args.data.filename,
          sizeBytes: args.data.sizeBytes,
          createdAt: new Date(),
        };
      },
      update: async (args: any) => {
        return {
          id: args.where.id,
          jobId,
          diskPath: createdDiskPath ?? null,
          storageKey: createdStorageKey ?? null,
          type: "image",
          mimeType: "image/png",
          filename: "pic.png",
          sizeBytes: 3,
          createdAt: new Date(),
          url: args.data.url,
        };
      },
    },
    $transaction: async (fn: any) => fn({ jobAttachment: (prisma as any).jobAttachment }),
  };

  const enqueueWebhookEvent = async () => {};

  const handler = createPostJobAttachmentUploadHandler({
    prisma: prisma as any,
    uploadsDir: tmpUploads,
    maxAttachmentBytes: 15 * 1024 * 1024,
    storageProvider: storageProvider as any,
    makeUploadBasename: () => "fixed.png",
    enqueueWebhookEvent,
    nodeEnv: "production",
  });

  const app = express();
  app.post("/jobs/:jobId/attachments/upload", (req, _res, next) => {
    (req as any).user = { userId: consumerId, role: "CONSUMER" };
    (req as any).validated = { params: { jobId } };
    (req as any).file = {
      originalname: "pic.png",
      mimetype: "image/png",
      size: 3,
      buffer: Buffer.from([1, 2, 3]),
    };
    next();
  }, handler);

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/jobs/${jobId}/attachments/upload`, {
    method: "POST",
    headers: { host: "example.test" },
  });

  assert.equal(res.status, 201);
  const body = await res.json();

  assert.equal(putCalls, 1);
  assert.equal(createdDiskPath, null);
  assert.equal(body.attachment.diskPath, null);

  assert.equal(typeof lastPutKey, "string");
  assert.ok(lastPutKey!.startsWith(`attachments/job/${jobId}/`));
  assert.equal(body.attachment.storageKey, lastPutKey);
});
