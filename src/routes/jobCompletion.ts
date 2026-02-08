import type { Request, Response } from "express";
import { z } from "zod";

import { canConfirmComplete, canMarkComplete } from "../services/jobFlowGuards";
import { logger } from "../services/logger";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

function isMissingDbColumnError(err: any): boolean {
  const msg = String(err?.message ?? "");
  return msg.includes("does not exist") && msg.includes("column");
}

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

async function resolveParticipants(prisma: any, jobId: number): Promise<{
  job: any;
  providerId: number | null;
}> {
  // Prefer awardedProviderId if present; fall back to accepted bid.
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      title: true,
      location: true,
      status: true,
      consumerId: true,
      createdAt: true,
      awardedProviderId: true,
      completionPendingForUserId: true,
      completedAt: true,
    },
  });

  let providerId: number | null = typeof job?.awardedProviderId === "number" ? job.awardedProviderId : null;
  if (!providerId) {
    const acceptedBid = await prisma.bid.findFirst({
      where: { jobId, status: "ACCEPTED" },
      select: { providerId: true },
    });
    providerId = acceptedBid?.providerId ?? null;
  }

  return { job, providerId };
}

export function createPostJobMarkCompleteHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER" && req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only consumers or providers can mark complete." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid id parameter" });
      const jobId = parsedParams.data.id;

      let job: any;
      let providerId: number | null = null;

      try {
        const resolved = await resolveParticipants(prisma, jobId);
        job = resolved.job;
        providerId = resolved.providerId;
      } catch (err: any) {
        if (isMissingDbColumnError(err)) {
          return res.status(501).json({
            error: "Completion confirmation is not enabled on this server yet. Apply DB migrations and redeploy.",
            code: "JOB_COMPLETION_NOT_ENABLED",
          });
        }
        throw err;
      }

      if (!job) return res.status(404).json({ error: "Job not found." });
      if (!providerId) return res.status(400).json({ error: "No awarded provider for this job." });

      const me = req.user.userId;
      const isConsumer = me === job.consumerId;
      const isProvider = me === providerId;
      if (!isConsumer && !isProvider) {
        return res.status(403).json({ error: "Not allowed." });
      }

      if (!canMarkComplete(job.status)) {
        return res.status(400).json({ error: `Job cannot be marked complete from status ${job.status}.` });
      }

      const pendingForUserId = isConsumer ? providerId : job.consumerId;
      const now = new Date();

      const previousStatus = job.status;

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED_PENDING_CONFIRMATION",
          completionPendingForUserId: pendingForUserId,
          completedAt: null,
        },
      });

      await auditSecurityEvent?.(req, "job.completion_marked", {
        targetType: "JOB",
        targetId: String(jobId),
        jobId,
        previousStatus,
        newStatus: updatedJob.status,
        completionPendingForUserId: pendingForUserId,
      });

      // Notify both parties
      await createNotification({
        userId: pendingForUserId,
        type: "JOB_COMPLETION_CONFIRM_REQUIRED",
        content: `Job "${job.title}" was marked complete. Please confirm completion.`,
      });

      await createNotification({
        userId: me,
        type: "JOB_COMPLETION_MARKED",
        content: `You marked "${job.title}" complete. Waiting for confirmation.`,
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId,
          consumerId: job.consumerId,
          previousStatus,
          newStatus: updatedJob.status,
          jobTitle: job.title,
          changedAt: now,
        },
      });

      return res.json({
        message: "Completion requested. Waiting for the other participant to confirm.",
        job: updatedJob,
      });
    } catch (err) {
      logger.error("jobs.mark_complete_error", { message: String((err as any)?.message ?? err) });
      return res.status(500).json({ error: "Internal server error while marking complete." });
    }
  };
}

export function createPostJobConfirmCompleteHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER" && req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only consumers or providers can confirm completion." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid id parameter" });
      const jobId = parsedParams.data.id;

      let job: any;
      let providerId: number | null = null;

      try {
        const resolved = await resolveParticipants(prisma, jobId);
        job = resolved.job;
        providerId = resolved.providerId;
      } catch (err: any) {
        if (isMissingDbColumnError(err)) {
          return res.status(501).json({
            error: "Completion confirmation is not enabled on this server yet. Apply DB migrations and redeploy.",
            code: "JOB_COMPLETION_NOT_ENABLED",
          });
        }
        throw err;
      }

      if (!job) return res.status(404).json({ error: "Job not found." });
      if (!providerId) return res.status(400).json({ error: "No awarded provider for this job." });

      const me = req.user.userId;
      const isConsumer = me === job.consumerId;
      const isProvider = me === providerId;
      if (!isConsumer && !isProvider) {
        return res.status(403).json({ error: "Not allowed." });
      }

      if (!canConfirmComplete(job.status)) {
        return res.status(400).json({ error: `Job cannot be confirmed from status ${job.status}.` });
      }

      const pendingForUserId = job.completionPendingForUserId;
      if (pendingForUserId !== me) {
        return res.status(403).json({ error: "You are not the user who needs to confirm completion." });
      }

      const now = new Date();
      const previousStatus = job.status;

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          completionPendingForUserId: null,
          completedAt: now,
        },
      });

      await auditSecurityEvent?.(req, "job.completed", {
        targetType: "JOB",
        targetId: String(jobId),
        jobId,
        previousStatus,
        newStatus: updatedJob.status,
        completedAt: now.toISOString(),
      });

      // Notify both parties
      await createNotification({
        userId: job.consumerId,
        type: "JOB_COMPLETED",
        content: `Job "${job.title}" is completed.`,
      });
      await createNotification({
        userId: providerId,
        type: "JOB_COMPLETED",
        content: `Job "${job.title}" is completed.`,
      });

      await enqueueWebhookEvent({
        eventType: "job.completed",
        payload: {
          jobId,
          consumerId: job.consumerId,
          providerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: job.title,
          location: job.location,
          createdAt: job.createdAt,
          completedAt: now,
        },
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId,
          consumerId: job.consumerId,
          previousStatus,
          newStatus: updatedJob.status,
          jobTitle: job.title,
          changedAt: now,
        },
      });

      return res.json({
        message: "Job completed.",
        job: updatedJob,
      });
    } catch (err) {
      logger.error("jobs.confirm_complete_error", { message: String((err as any)?.message ?? err) });
      return res.status(500).json({ error: "Internal server error while confirming completion." });
    }
  };
}
