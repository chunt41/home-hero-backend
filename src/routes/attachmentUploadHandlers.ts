import * as fs from "node:fs";
import * as path from "node:path";

import type { Request, Response } from "express";

import { computeNewUploadTargets } from "../services/objectStorageUploads";
import type { StorageProvider } from "../storage/storageProvider";

type AuthUser = {
  userId: number;
  role: "CONSUMER" | "PROVIDER" | "ADMIN";
};

type AuthRequestLike = Request & {
  user?: AuthUser;
  validated?: {
    params?: unknown;
  };
  file?: Express.Multer.File;
};

function defaultPublicBase(req: Request): string {
  return (process.env.PUBLIC_BASE_URL ?? "").trim() || `${req.protocol}://${req.get("host")}`;
}

export function createPostJobAttachmentUploadHandler(deps: {
  prisma: {
    job: {
      findUnique: (args: any) => Promise<{
        id: number;
        consumerId: number;
        status: string;
        title: string;
        location: string;
      } | null>;
    };
    $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  };
  uploadsDir: string;
  maxAttachmentBytes: number;
  storageProvider?: StorageProvider;
  makeUploadBasename: (originalName: string | undefined) => string;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  logServerError?: (message: string, err: unknown, fields?: Record<string, unknown>) => void;
  getPublicBase?: (req: Request) => string;
  nodeEnv?: string;
}) {
  const getPublicBase = deps.getPublicBase ?? defaultPublicBase;

  return async (req: AuthRequestLike, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { jobId } = (req as any).validated?.params as { jobId: number };

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: "file is required" });
      }

      const job = await deps.prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true, status: true, title: true, location: true },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.consumerId !== req.user.userId) {
        return res.status(403).json({
          error: "You may only add attachments to jobs you created.",
        });
      }

      const publicBase = getPublicBase(req);

      const kind = file.mimetype.startsWith("video/") ? "video" : "image";
      const basename = deps.makeUploadBasename(file.originalname);

      const targetParams: any = {
        namespace: "job",
        ownerId: jobId,
        basename,
        storageProvider: deps.storageProvider,
      };
      if (typeof deps.nodeEnv === "string") targetParams.nodeEnv = deps.nodeEnv;

      const { storageKey, diskPath } = computeNewUploadTargets(targetParams);

      let cleanupOnDbFailure: null | (() => Promise<void>) = null;
      if (deps.storageProvider && storageKey) {
        await deps.storageProvider.putObject(storageKey, file.buffer, file.mimetype);
        cleanupOnDbFailure = async () => {
          await deps.storageProvider?.deleteObject(storageKey).catch(() => null);
        };
      } else if (diskPath) {
        const abs = path.join(deps.uploadsDir, diskPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, file.buffer);
        cleanupOnDbFailure = async () => {
          await fs.promises.unlink(abs).catch(() => null);
        };
      }

      let attach: any;
      try {
        attach = await deps.prisma.$transaction(async (tx) => {
          const created = await tx.jobAttachment.create({
            data: {
              jobId,
              url: "",
              diskPath,
              storageKey,
              uploaderUserId: req.user!.userId,
              type: kind,
              mimeType: file.mimetype,
              filename: file.originalname || null,
              sizeBytes: file.size || null,
            },
          });

          const url = `${publicBase}/attachments/${created.id}`;
          return tx.jobAttachment.update({
            where: { id: created.id },
            data: { url },
          });
        });
      } catch (e) {
        await cleanupOnDbFailure?.();
        throw e;
      }

      await deps.enqueueWebhookEvent({
        eventType: "job.attachment_added",
        payload: {
          attachmentId: attach.id,
          jobId: attach.jobId,
          addedByUserId: req.user.userId,
          url: `${publicBase}/attachments/${attach.id}`,
          type: attach.type,
          mimeType: attach.mimeType,
          filename: attach.filename,
          sizeBytes: attach.sizeBytes,
          createdAt: attach.createdAt,
          job: {
            title: job.title,
            status: job.status,
            location: job.location,
          },
        },
      });

      return res.status(201).json({
        message: "Attachment uploaded.",
        attachment: {
          ...attach,
          url: `${publicBase}/attachments/${attach.id}`,
        },
        limits: { maxBytes: deps.maxAttachmentBytes },
      });
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("File too large")) {
        return res.status(413).json({
          error: `Attachment exceeds size limit (${deps.maxAttachmentBytes} bytes).`,
        });
      }
      if (msg.includes("Unsupported file type")) {
        return res.status(415).json({ error: msg });
      }

      deps.logServerError?.("POST /jobs/:jobId/attachments/upload error", err);
      return res.status(500).json({
        error: "Internal server error while uploading attachment.",
      });
    }
  };
}

export function createPostVerificationAttachmentUploadHandler(deps: {
  prisma: {
    providerVerification: {
      upsert: (args: any) => Promise<any>;
    };
    providerVerificationAttachment: {
      create: (args: any) => Promise<any>;
    };
  };
  uploadsDir: string;
  storageProvider?: StorageProvider;
  makeUploadBasename: (originalName: string | undefined) => string;
  logServerError?: (message: string, err: unknown, fields?: Record<string, unknown>) => void;
  getPublicBase?: (req: Request) => string;
  nodeEnv?: string;
}) {
  const getPublicBase = deps.getPublicBase ?? defaultPublicBase;

  return async (req: AuthRequestLike, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can upload verification documents." });
      }

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: "file is required" });
      }

      await deps.prisma.providerVerification.upsert({
        where: { providerId: req.user.userId },
        create: { providerId: req.user.userId },
        update: {},
      });

      const basename = deps.makeUploadBasename(file.originalname);

      const targetParams: any = {
        namespace: "verification",
        ownerId: req.user.userId,
        basename,
        storageProvider: deps.storageProvider,
      };
      if (typeof deps.nodeEnv === "string") targetParams.nodeEnv = deps.nodeEnv;

      const { storageKey, diskPath } = computeNewUploadTargets(targetParams);

      let cleanupOnDbFailure: null | (() => Promise<void>) = null;
      if (deps.storageProvider && storageKey) {
        await deps.storageProvider.putObject(storageKey, file.buffer, file.mimetype);
        cleanupOnDbFailure = async () => {
          await deps.storageProvider?.deleteObject(storageKey).catch(() => null);
        };
      } else if (diskPath) {
        const abs = path.join(deps.uploadsDir, diskPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, file.buffer);
        cleanupOnDbFailure = async () => {
          await fs.promises.unlink(abs).catch(() => null);
        };
      }

      let attach: any;
      try {
        attach = await deps.prisma.providerVerificationAttachment.create({
          data: {
            providerId: req.user.userId,
            uploaderUserId: req.user.userId,
            diskPath,
            storageKey,
            mimeType: file.mimetype,
            filename: file.originalname || null,
            sizeBytes: file.size || null,
          },
          select: {
            id: true,
            providerId: true,
            mimeType: true,
            filename: true,
            sizeBytes: true,
            createdAt: true,
          },
        });
      } catch (e) {
        await cleanupOnDbFailure?.();
        throw e;
      }

      const publicBase = getPublicBase(req);

      return res.json({
        attachment: {
          ...attach,
          url: `${publicBase}/provider/verification/attachments/${attach.id}`,
        },
      });
    } catch (err) {
      deps.logServerError?.("POST /provider/verification/attachments/upload error", err);
      return res.status(500).json({ error: "Internal server error while uploading verification document." });
    }
  };
}
