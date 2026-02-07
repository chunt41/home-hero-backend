import type { Request, Response } from "express";
import { z } from "zod";

import { canOpenDispute } from "../services/jobFlowGuards";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const openDisputeParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
});

const openDisputeBodySchema = z.object({
  reasonCode: z.string().trim().min(1).max(100),
  description: z.string().trim().max(5000).optional(),
});

const resolveDisputeParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const resolveDisputeBodySchema = z.object({
  jobStatus: z.enum(["COMPLETED", "CANCELLED"]),
  resolutionNotes: z.string().trim().min(1).max(5000),
});

export function createPostJobDisputesHandler(deps: {
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
        return res.status(403).json({ error: "Only consumers or providers can open disputes." });
      }

      const parsedParams = openDisputeParamsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid jobId parameter" });
      const jobId = parsedParams.data.jobId;

      const parsedBody = openDisputeBodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request body" });
      }
      const { reasonCode, description } = parsedBody.data;

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          status: true,
          title: true,
          awardedProviderId: true,
        },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      const previousStatus = job.status;

      if (!canOpenDispute(job.status)) {
        return res.status(400).json({
          error: `Disputes can only be opened for IN_PROGRESS, COMPLETED_PENDING_CONFIRMATION, or COMPLETED jobs. Current status: ${job.status}.`,
        });
      }

      const acceptedBid = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { providerId: true },
      });

      const providerId: number | null =
        typeof job.awardedProviderId === "number" ? job.awardedProviderId : acceptedBid?.providerId ?? null;

      const me = req.user.userId;
      const isConsumerParticipant = job.consumerId === me;
      const isProviderParticipant = providerId === me;
      if (!isConsumerParticipant && !isProviderParticipant) {
        return res.status(403).json({ error: "Not allowed." });
      }

      const existingOpen = await prisma.dispute.findFirst({
        where: {
          jobId,
          status: { in: ["OPEN", "INVESTIGATING"] },
        },
        select: { id: true },
      });

      if (existingOpen) {
        return res.status(409).json({ error: "A dispute is already open for this job." });
      }

      const now = new Date();

      const dispute = await prisma.dispute.create({
        data: {
          jobId,
          openedByUserId: me,
          reasonCode,
          description: description?.trim() || null,
        },
      });

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: { status: "DISPUTED" },
        select: { id: true, status: true },
      });

      // Notify both participants
      const notifyIds = new Set<number>([job.consumerId]);
      if (providerId) notifyIds.add(providerId);
      for (const uid of notifyIds) {
        await createNotification({
          userId: uid,
          type: "JOB_DISPUTED",
          content: `A dispute was opened for \"${job.title}\".`,
        });
      }

      // Notify admins
      const admins: Array<{ id: number }> = await prisma.user.findMany({
        where: { role: "ADMIN" },
        select: { id: true },
      });
      for (const a of admins) {
        await createNotification({
          userId: a.id,
          type: "ADMIN_JOB_DISPUTED",
          content: {
            jobId,
            disputeId: dispute.id,
            jobTitle: job.title,
            previousStatus,
            newStatus: updatedJob.status,
            openedByUserId: me,
            reasonCode: dispute.reasonCode,
          },
        });
      }

      await auditSecurityEvent?.(req as any, "job.disputed", {
        targetType: "JOB",
        targetId: String(jobId),
        jobId,
        previousStatus,
        newStatus: updatedJob.status,
        disputeId: dispute.id,
        openedByUserId: me,
        reasonCode: dispute.reasonCode,
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

      await enqueueWebhookEvent({
        eventType: "dispute.created",
        payload: {
          disputeId: dispute.id,
          jobId: job.id,
          jobTitle: job.title,
          openedByUserId: me,
          reasonCode: dispute.reasonCode,
          status: dispute.status,
          createdAt: dispute.createdAt,
        },
      });

      return res.status(201).json({ dispute });
    } catch (err) {
      console.error("POST /jobs/:jobId/disputes error:", err);
      return res.status(500).json({ error: "Internal server error while opening dispute." });
    }
  };
}

export function createPostAdminResolveDisputeHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({ error: "Admin only." });
      }

      const parsedParams = resolveDisputeParamsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid dispute id" });
      const disputeId = parsedParams.data.id;

      const parsedBody = resolveDisputeBodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request body" });
      }

      const { jobStatus, resolutionNotes } = parsedBody.data;

      const dispute = await prisma.dispute.findUnique({
        where: { id: disputeId },
        select: {
          id: true,
          jobId: true,
          status: true,
          reasonCode: true,
          openedByUserId: true,
        },
      });

      if (!dispute) return res.status(404).json({ error: "Dispute not found." });
      if (dispute.status === "RESOLVED") {
        return res.status(409).json({ error: "Dispute is already resolved." });
      }

      const job = await prisma.job.findUnique({
        where: { id: dispute.jobId },
        select: {
          id: true,
          title: true,
          status: true,
          consumerId: true,
          awardedProviderId: true,
        },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      if (job.status !== "DISPUTED") {
        return res.status(400).json({
          error: `Cannot resolve dispute unless job is DISPUTED (current: ${job.status}).`,
        });
      }

      const acceptedBid = await prisma.bid.findFirst({
        where: { jobId: job.id, status: "ACCEPTED" },
        select: { providerId: true },
      });

      const providerId: number | null =
        typeof job.awardedProviderId === "number" ? job.awardedProviderId : acceptedBid?.providerId ?? null;

      const now = new Date();

      const updatedDispute = await prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: "RESOLVED",
          resolvedAt: now,
          resolutionNotes,
          resolvedByAdminId: req.user.userId,
          resolutionJobStatus: jobStatus,
        },
      });

      const updatedJob = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: jobStatus,
        },
        select: { id: true, status: true },
      });

      // Notify participants
      const notifyIds = new Set<number>([job.consumerId]);
      if (providerId) notifyIds.add(providerId);
      for (const uid of notifyIds) {
        await createNotification({
          userId: uid,
          type: "DISPUTE_RESOLVED",
          content: {
            jobId: job.id,
            disputeId: updatedDispute.id,
            jobTitle: job.title,
            jobStatus: updatedJob.status,
            resolutionNotes: updatedDispute.resolutionNotes,
          },
        });
      }

      await auditSecurityEvent?.(req as any, "dispute.resolved", {
        targetType: "DISPUTE",
        targetId: String(updatedDispute.id),
        disputeId: updatedDispute.id,
        jobId: job.id,
        previousJobStatus: job.status,
        newJobStatus: updatedJob.status,
        resolutionJobStatus: jobStatus,
        resolvedByAdminId: req.user.userId,
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId: job.id,
          consumerId: job.consumerId,
          previousStatus: job.status,
          newStatus: updatedJob.status,
          jobTitle: job.title,
          changedAt: now,
        },
      });

      await enqueueWebhookEvent({
        eventType: "dispute.resolved",
        payload: {
          disputeId: updatedDispute.id,
          jobId: job.id,
          status: updatedDispute.status,
          resolvedAt: updatedDispute.resolvedAt,
          resolutionNotes: updatedDispute.resolutionNotes,
          resolutionJobStatus: jobStatus,
        },
      });

      return res.json({ dispute: updatedDispute, job: updatedJob });
    } catch (err) {
      console.error("POST /admin/disputes/:id/resolve error:", err);
      return res.status(500).json({ error: "Internal server error while resolving dispute." });
    }
  };
}
