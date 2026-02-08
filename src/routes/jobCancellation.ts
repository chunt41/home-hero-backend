import type { Request, Response } from "express";
import { z } from "zod";

import { canCancelJob } from "../services/jobFlowGuards";
import { cancellationReasonLabel } from "../services/jobCancellationReasons";
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
  jobId: z.coerce.number().int().positive(),
});

const cancellationReasonCodeSchema = z.enum([
  "CHANGE_OF_PLANS",
  "HIRED_SOMEONE_ELSE",
  "TOO_EXPENSIVE",
  "SCHEDULING_CONFLICT",
  "NO_SHOW",
  "UNRESPONSIVE",
  "SAFETY_CONCERN",
  "DUPLICATE_JOB",
  "OTHER",
]);

const bodySchema = z
  .object({
    reasonCode: cancellationReasonCodeSchema,
    reasonDetails: z.string().trim().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reasonCode === "OTHER") {
      const details = (val.reasonDetails ?? "").trim();
      if (details.length < 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "reasonDetails is required when reasonCode is OTHER.",
          path: ["reasonDetails"],
        });
      }
    }
  });

async function resolveParticipants(prisma: any, jobId: number): Promise<{
  job: any;
  providerId: number | null;
}> {
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
      cancelledAt: true,
      cancelledByUserId: true,
      cancellationReasonCode: true,
      cancellationReasonDetails: true,
    },
  });

  let providerId: number | null =
    typeof job?.awardedProviderId === "number" ? job.awardedProviderId : null;

  if (!providerId) {
    const acceptedBid = await prisma.bid.findFirst({
      where: { jobId, status: "ACCEPTED" },
      select: { providerId: true },
    });
    providerId = acceptedBid?.providerId ?? null;
  }

  return { job, providerId };
}

export function createPostJobCancelHandler(deps: {
  prisma: any;
  createNotification: (args: { userId: number; type: string; content: any }) => Promise<void>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
  auditSecurityEvent?: (req: Request, actionType: string, metadata?: Record<string, any>) => Promise<void>;
}) {
  const { prisma, createNotification, enqueueWebhookEvent, auditSecurityEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      if (req.user.role !== "CONSUMER" && req.user.role !== "PROVIDER" && req.user.role !== "ADMIN") {
        return res.status(403).json({ error: "Not allowed." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid jobId parameter" });
      const jobId = parsedParams.data.jobId;

      const parsedBody = bodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({ error: "Invalid request body", details: parsedBody.error.flatten() });
      }

      const { reasonCode, reasonDetails } = parsedBody.data;

      let job: any;
      let providerId: number | null = null;

      try {
        const resolved = await resolveParticipants(prisma, jobId);
        job = resolved.job;
        providerId = resolved.providerId;
      } catch (err: any) {
        if (isMissingDbColumnError(err)) {
          return res.status(501).json({
            error: "Cancellation metadata is not enabled on this server yet. Apply DB migrations and redeploy.",
            code: "JOB_CANCELLATION_NOT_ENABLED",
          });
        }
        throw err;
      }

      if (!job) return res.status(404).json({ error: "Job not found." });

      const me = req.user.userId;
      const role = req.user.role;

      const isConsumer = role === "CONSUMER" && me === job.consumerId;
      const isProvider = role === "PROVIDER" && !!providerId && me === providerId;
      const isAdmin = role === "ADMIN";

      if (!isConsumer && !isProvider && !isAdmin) {
        return res.status(403).json({ error: "Not allowed." });
      }

      if (!canCancelJob(job.status)) {
        return res.status(400).json({
          error: `Only jobs that are OPEN, AWARDED, or IN_PROGRESS can be cancelled. Current status: ${job.status}.`,
        });
      }

      // Providers can only cancel jobs they are awarded for.
      if (isProvider && job.status !== "AWARDED" && job.status !== "IN_PROGRESS") {
        return res.status(400).json({ error: `Providers cannot cancel jobs in status ${job.status}.` });
      }

      const previousStatus = job.status;
      const now = new Date();
      const cancelledByRole = isAdmin ? "ADMIN" : isProvider ? "PROVIDER" : "CONSUMER";

      const [_, updatedJob] = await prisma.$transaction([
        prisma.bid.updateMany({
          where: { jobId },
          data: { status: "DECLINED" },
        }),
        prisma.job.update({
          where: { id: jobId },
          data: {
            status: "CANCELLED",
            cancelledAt: now,
            cancelledByUserId: me,
            cancellationReasonCode: reasonCode,
            cancellationReasonDetails: reasonDetails?.trim() ? reasonDetails.trim() : null,
          },
          select: {
            id: true,
            title: true,
            location: true,
            status: true,
            createdAt: true,
            cancelledAt: true,
            cancelledByUserId: true,
            cancellationReasonCode: true,
            cancellationReasonDetails: true,
          },
        }),
      ]);

      const reasonLabel = cancellationReasonLabel(updatedJob.cancellationReasonCode);

      const notifyUserIds = new Set<number>();
      notifyUserIds.add(job.consumerId);
      if (providerId) notifyUserIds.add(providerId);

      const notificationText = `Job "${job.title}" was cancelled.`;

      await Promise.all(
        Array.from(notifyUserIds).map((userId) =>
          createNotification({
            userId,
            type: "JOB_CANCELLED",
            content: notificationText,
          })
        )
      );

      await auditSecurityEvent?.(req as any, "job.cancelled", {
        targetType: "JOB",
        targetId: String(jobId),
        jobId,
        previousStatus,
        newStatus: updatedJob.status,
        cancelledByRole,
        cancelledByUserId: me,
        awardedProviderId: providerId,
        reasonCode,
      });

      await enqueueWebhookEvent({
        eventType: "job.cancelled",
        payload: {
          jobId: updatedJob.id,
          consumerId: job.consumerId,
          providerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: updatedJob.title,
          location: updatedJob.location,
          createdAt: updatedJob.createdAt,
          cancelledAt: updatedJob.cancelledAt ?? now,
          cancelledByRole,
          cancelledByUserId: me,
          reasonCode,
          reasonLabel,
        },
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId: updatedJob.id,
          consumerId: job.consumerId,
          providerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: updatedJob.title,
          changedAt: updatedJob.cancelledAt ?? now,
        },
      });

      return res.json({
        message: "Job cancelled successfully.",
        job: {
          ...updatedJob,
          cancellationReasonLabel: reasonLabel,
        },
      });
    } catch (err) {
      logger.error("jobs.cancel_error", { message: String((err as any)?.message ?? err) });
      return res.status(500).json({ error: "Internal server error while cancelling job." });
    }
  };
}
