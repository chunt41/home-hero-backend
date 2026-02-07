import type { Request, Response } from "express";
import { z } from "zod";

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
  jobId: z.coerce.number().int().positive(),
});

const bodySchema = z
  .object({
    bidId: z.coerce.number().int().positive().optional(),
    providerId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((val, ctx) => {
    const count = (val.bidId ? 1 : 0) + (val.providerId ? 1 : 0);
    if (count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of bidId or providerId.",
      });
    }
  });

export function createPostJobAwardHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers can award a provider." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        return res.status(400).json({ error: "Invalid jobId parameter" });
      }

      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request body" });
      }

      const jobId = parsedParams.data.jobId;
      const { bidId, providerId } = parsedBody.data;

      let job: any;
      try {
        job = await prisma.job.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            title: true,
            status: true,
            consumerId: true,
            awardedProviderId: true,
            awardedAt: true,
          },
        });
      } catch (err: any) {
        if (isMissingDbColumnError(err)) {
          return res.status(501).json({
            error: "Awarding is not enabled on this server yet. Apply DB migrations and redeploy.",
            code: "JOB_AWARD_NOT_ENABLED",
          });
        }
        throw err;
      }

      if (!job) return res.status(404).json({ error: "Job not found." });

      if (job.consumerId !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this job." });
      }

      if (job.status !== "OPEN") {
        return res.status(400).json({ error: `Job is not OPEN (current: ${job.status}).` });
      }

      // Resolve target bid
      let bid: any = null;
      if (typeof bidId === "number") {
        bid = await prisma.bid.findUnique({
          where: { id: bidId },
          select: { id: true, jobId: true, providerId: true, status: true, amount: true },
        });
      } else if (typeof providerId === "number") {
        bid = await prisma.bid.findFirst({
          where: { jobId, providerId },
          select: { id: true, jobId: true, providerId: true, status: true, amount: true },
        });
      }

      if (!bid || bid.jobId !== job.id) {
        return res.status(404).json({ error: "Bid not found for this job." });
      }

      const previousJobStatus = job.status;
      const now = new Date();

      const result = await prisma.$transaction(async (tx: any) => {
        const accepted = await tx.bid.update({
          where: { id: bid.id },
          data: { status: "ACCEPTED" },
        });

        await tx.bid.updateMany({
          where: { jobId: job.id, id: { not: bid.id }, status: "PENDING" },
          data: { status: "DECLINED" },
        });

        const updatedJob = await tx.job.update({
          where: { id: job.id },
          data: {
            status: "AWARDED",
            awardedProviderId: bid.providerId,
            awardedAt: now,
          },
        });

        return { accepted, updatedJob };
      });

      // Notify both parties
      await createNotification({
        userId: bid.providerId,
        type: "JOB_AWARDED",
        content: `You were awarded for "${job.title}".`,
      });
      await createNotification({
        userId: job.consumerId,
        type: "JOB_AWARDED",
        content: `You awarded a provider for "${job.title}".`,
      });

      await auditSecurityEvent?.(req, "job.awarded", {
        targetType: "JOB",
        targetId: String(job.id),
        jobId: job.id,
        previousStatus: previousJobStatus,
        newStatus: result.updatedJob.status,
        awardedProviderId: bid.providerId,
        bidId: bid.id,
      });

      await enqueueWebhookEvent({
        eventType: "bid.accepted",
        payload: {
          bidId: result.accepted.id,
          jobId: job.id,
          consumerId: job.consumerId,
          providerId: bid.providerId,
          amount: bid.amount,
          jobTitle: job.title,
          acceptedAt: now,
        },
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId: result.updatedJob.id,
          consumerId: job.consumerId,
          previousStatus: previousJobStatus,
          newStatus: result.updatedJob.status,
          jobTitle: job.title,
          changedAt: now,
        },
      });

      return res.json({
        message: "Provider awarded. Job is now AWARDED.",
        job: result.updatedJob,
        acceptedBid: result.accepted,
      });
    } catch (err) {
      console.error("POST /jobs/:jobId/award error:", err);
      return res.status(500).json({ error: "Internal server error while awarding provider." });
    }
  };
}
