import type { Request, Response, NextFunction } from "express";
import * as fs from "node:fs";

import {
  canAccessJobAttachment,
  resolveDiskPathInsideUploadsDir,
  sanitizeFilenameForHeader,
  shouldInlineContentType,
} from "../utils/attachmentsGuard";

export type AuthUserLike = {
  userId: number;
  role: "CONSUMER" | "PROVIDER" | "ADMIN" | string;
};

export type AuthRequestLike = Request & {
  user?: AuthUserLike;
};

type PrismaLike = {
  jobAttachment: {
    findUnique: (args: any) => Promise<{
      id: number;
      jobId: number;
      mimeType: string | null;
      filename: string | null;
      sizeBytes: number | null;
      diskPath: string | null;
    } | null>;
  };
  messageAttachment: {
    findUnique: (args: any) => Promise<{
      id: number;
      mimeType: string | null;
      filename: string | null;
      sizeBytes: number | null;
      diskPath: string | null;
      message: { jobId: number };
    } | null>;
  };
  job: {
    findUnique: (args: any) => Promise<{ id: number; consumerId: number } | null>;
  };
  bid: {
    findFirst: (args: any) => Promise<{ id: number } | null>;
  };
};

function isAdmin(req: AuthRequestLike): boolean {
  return req.user?.role === "ADMIN";
}

export function createGetAttachmentHandler(args: { prisma: PrismaLike; uploadsDir: string }) {
  const { prisma, uploadsDir } = args;

  return async (req: AuthRequestLike, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid attachment id" });

      // Try job attachment first
      const jobAttach = await prisma.jobAttachment.findUnique({
        where: { id },
        select: {
          id: true,
          jobId: true,
          mimeType: true,
          filename: true,
          sizeBytes: true,
          diskPath: true,
        },
      });

      let jobId: number | null = jobAttach?.jobId ?? null;
      let diskPath: string | null | undefined = jobAttach?.diskPath;
      let mimeType: string | null | undefined = jobAttach?.mimeType;
      let filename: string | null | undefined = jobAttach?.filename;
      let sizeBytes: number | null | undefined = jobAttach?.sizeBytes;

      if (!jobAttach) {
        const msgAttach = await prisma.messageAttachment.findUnique({
          where: { id },
          select: {
            id: true,
            mimeType: true,
            filename: true,
            sizeBytes: true,
            diskPath: true,
            message: { select: { jobId: true } },
          },
        });

        if (!msgAttach) {
          return res.status(404).json({ error: "Attachment not found" });
        }

        jobId = msgAttach.message.jobId;
        diskPath = msgAttach.diskPath;
        mimeType = msgAttach.mimeType;
        filename = msgAttach.filename;
        sizeBytes = msgAttach.sizeBytes;
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId! },
        select: { id: true, consumerId: true },
      });

      if (!job) return res.status(404).json({ error: "Job not found" });

      let requesterHasBidOnJob = false;
      if (!isAdmin(req) && req.user.role === "PROVIDER" && req.user.userId !== job.consumerId) {
        const bid = await prisma.bid.findFirst({
          where: { jobId: job.id, providerId: req.user.userId },
          select: { id: true },
        });
        requesterHasBidOnJob = !!bid;
      }

      const authorized = canAccessJobAttachment({
        requesterRole: req.user.role,
        requesterUserId: req.user.userId,
        jobConsumerId: job.consumerId,
        requesterHasBidOnJob,
      });

      if (!authorized) {
        return res.status(403).json({ error: "Not allowed to access this attachment." });
      }

      if (!diskPath) {
        return res.status(404).json({ error: "Attachment file is not available." });
      }

      let absPath: string;
      try {
        absPath = resolveDiskPathInsideUploadsDir(uploadsDir, diskPath);
      } catch {
        return res.status(400).json({ error: "Invalid attachment path." });
      }

      let st: fs.Stats;
      try {
        st = await fs.promises.stat(absPath);
        if (!st.isFile()) {
          return res.status(404).json({ error: "Attachment file not found." });
        }
      } catch {
        return res.status(404).json({ error: "Attachment file not found." });
      }

      const ct = mimeType || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("X-Content-Type-Options", "nosniff");

      const safeName = sanitizeFilenameForHeader(filename);
      const dispoType = shouldInlineContentType(ct) ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${dispoType}; filename=\"${safeName}\"`);

      if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > 0) {
        res.setHeader("Content-Length", String(sizeBytes));
      } else {
        res.setHeader("Content-Length", String(st.size));
      }

      const stream = fs.createReadStream(absPath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream attachment." });
        } else {
          res.end();
        }
        // best-effort: still forward for logging/monitoring
        next(err);
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  };
}
