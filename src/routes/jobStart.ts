import type { Request, Response } from "express";
import { z } from "zod";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function createPostJobStartHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only the awarded provider can start a job." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid id parameter" });
      const jobId = parsedParams.data.id;

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          title: true,
          status: true,
          consumerId: true,
          awardedProviderId: true,
        },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      if (job.status !== "AWARDED") {
        return res.status(400).json({ error: `Job is not AWARDED (current: ${job.status}).` });
      }

      if (job.awardedProviderId !== req.user.userId) {
        return res.status(403).json({ error: "Only the awarded provider can start this job." });
      }

      const previousStatus = job.status;
      const now = new Date();

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: { status: "IN_PROGRESS" },
      });

      // Notify both parties
      await createNotification({
        userId: job.consumerId,
        type: "JOB_STARTED",
        content: `Work started on "${job.title}".`,
      });
      await createNotification({
        userId: req.user.userId,
        type: "JOB_STARTED",
        content: `You started "${job.title}".`,
      });

      await auditSecurityEvent?.(req, "job.started", {
        targetType: "JOB",
        targetId: String(job.id),
        jobId: job.id,
        previousStatus,
        newStatus: updatedJob.status,
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
        message: "Job started.",
        job: updatedJob,
      });
    } catch (err) {
      console.error("POST /jobs/:id/start error:", err);
      return res.status(500).json({ error: "Internal server error while starting job." });
    }
  };
}
