import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs";

import { createGetAttachmentHandler } from "./attachments";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function makePrismaStub(data: {
  jobAttachment?: any;
  messageAttachment?: any;
  job?: any;
  bid?: any;
}) {
  return {
    jobAttachment: {
      findUnique: async (_args: any) => data.jobAttachment ?? null,
    },
    messageAttachment: {
      findUnique: async (_args: any) => data.messageAttachment ?? null,
    },
    job: {
      findUnique: async (_args: any) => data.job ?? null,
    },
    bid: {
      findFirst: async (_args: any) => data.bid ?? null,
    },
  };
}

test("GET /attachments/:id returns 403 for unauthorized provider", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));
  await fs.promises.mkdir(path.join(tmpUploads, "attachments"), { recursive: true });

  const prisma = makePrismaStub({
    jobAttachment: {
      id: 1,
      jobId: 10,
      mimeType: "application/pdf",
      filename: "doc.pdf",
      sizeBytes: 4,
      diskPath: "attachments/doc.pdf",
    },
    job: { id: 10, consumerId: 100 },
    bid: null,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 200, role: "PROVIDER" };
    next();
  });
  app.get("/attachments/:id", createGetAttachmentHandler({ prisma: prisma as any, uploadsDir: tmpUploads }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/attachments/1`);
  assert.equal(res.status, 403);
});

test("GET /attachments/:id streams for job consumer", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));
  const filePath = path.join(tmpUploads, "attachments", "doc.pdf");
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, "test");

  const prisma = makePrismaStub({
    jobAttachment: {
      id: 1,
      jobId: 10,
      mimeType: "application/pdf",
      filename: "doc.pdf",
      sizeBytes: 4,
      diskPath: "attachments/doc.pdf",
    },
    job: { id: 10, consumerId: 100 },
    bid: null,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 100, role: "CONSUMER" };
    next();
  });
  app.get("/attachments/:id", createGetAttachmentHandler({ prisma: prisma as any, uploadsDir: tmpUploads }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/attachments/1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(String(res.headers.get("content-disposition") ?? "").startsWith("inline"));
  const body = await res.text();
  assert.equal(body, "test");
});

test("GET /attachments/:id streams for provider with bid", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));
  const filePath = path.join(tmpUploads, "attachments", "img.jpg");
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, "hello");

  const prisma = makePrismaStub({
    jobAttachment: {
      id: 2,
      jobId: 11,
      mimeType: "image/jpeg",
      filename: "img.jpg",
      sizeBytes: 5,
      diskPath: "attachments/img.jpg",
    },
    job: { id: 11, consumerId: 100 },
    bid: { id: 999 },
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 200, role: "PROVIDER" };
    next();
  });
  app.get("/attachments/:id", createGetAttachmentHandler({ prisma: prisma as any, uploadsDir: tmpUploads }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/attachments/2`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, "hello");
});

test("GET /attachments/:id blocks path traversal", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));

  const prisma = makePrismaStub({
    jobAttachment: {
      id: 3,
      jobId: 12,
      mimeType: "application/pdf",
      filename: "x.pdf",
      sizeBytes: 1,
      diskPath: "../secrets.txt",
    },
    job: { id: 12, consumerId: 100 },
    bid: null,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 999, role: "ADMIN" };
    next();
  });
  app.get("/attachments/:id", createGetAttachmentHandler({ prisma: prisma as any, uploadsDir: tmpUploads }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/attachments/3`);
  assert.equal(res.status, 400);
});

test("GET /attachments/:id returns 404 when file missing", async (t) => {
  const tmpUploads = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hh-uploads-"));

  const prisma = makePrismaStub({
    jobAttachment: {
      id: 4,
      jobId: 13,
      mimeType: "application/pdf",
      filename: "missing.pdf",
      sizeBytes: 1,
      diskPath: "attachments/missing.pdf",
    },
    job: { id: 13, consumerId: 100 },
    bid: null,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 100, role: "CONSUMER" };
    next();
  });
  app.get("/attachments/:id", createGetAttachmentHandler({ prisma: prisma as any, uploadsDir: tmpUploads }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/attachments/4`);
  assert.equal(res.status, 404);
});
