import type { Request, Response } from "express";
import { z } from "zod";

import { logger } from "../services/logger";

import { canReviewJob } from "../services/jobFlowGuards";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
};

export type AuthRequest = Request & { user?: AuthUser };

const paramsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
});

const bodySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  text: z.string().max(2000).optional(),
  comment: z.string().max(2000).optional(),
});

export function createPostJobReviewsHandler(deps: {
  prisma: any;
  moderateReviewText: (text: string | null) =>
    | { ok: true; text: string | null }
    | { ok: false; error: string };
  recomputeProviderRating: (providerId: number) => Promise<any>;
  enqueueWebhookEvent: (args: { eventType: string; payload: Record<string, any> }) => Promise<void>;
}) {
  const { prisma, moderateReviewText, recomputeProviderRating, enqueueWebhookEvent } = deps;

  return async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (req.user.role !== "CONSUMER" && req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only consumers or providers can leave reviews." });
      }

      const parsedParams = paramsSchema.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid jobId parameter" });
      const jobId = parsedParams.data.jobId;

      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        return res.status(400).json({ error: parsedBody.error.issues[0]?.message ?? "Invalid request body" });
      }

      const { rating: ratingNum, text, comment } = parsedBody.data;

      const moderation = moderateReviewText(text ?? comment ?? null);
      if (!moderation.ok) {
        const { error } = moderation as { ok: false; error: string };
        return res.status(400).json({ error });
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true, status: true, title: true, awardedProviderId: true },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      if (!canReviewJob(job.status)) {
        return res.status(400).json({
          error: `Only COMPLETED jobs can be reviewed. Current status: ${job.status}.`,
        });
      }

      const acceptedBid = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { id: true, providerId: true },
      });

      const acceptedBidId: number | null = acceptedBid?.id ?? null;

      let providerId: number | null =
        typeof job.awardedProviderId === "number" ? job.awardedProviderId : null;
      if (!providerId) providerId = acceptedBid?.providerId ?? null;

      if (!providerId) {
        return res.status(400).json({
          error: "No accepted bid found for this job. Cannot determine which provider to review.",
        });
      }

      const reviewerUserId = req.user.userId;
      let revieweeUserId: number;

      if (req.user.role === "CONSUMER") {
        if (job.consumerId !== reviewerUserId) {
          return res.status(403).json({ error: "You can only review jobs that you created." });
        }
        revieweeUserId = providerId;
      } else {
        if (providerId !== reviewerUserId) {
          return res.status(403).json({ error: "Only the accepted provider can review this job." });
        }
        revieweeUserId = job.consumerId;
      }

      const existing = await prisma.review.findUnique({
        where: {
          jobId_reviewerUserId: {
            jobId,
            reviewerUserId,
          },
        },
      });

      const textValue = moderation.text;

      let review;
      let eventType: "review.created" | "review.updated" = "review.created";

      if (existing) {
        eventType = "review.updated";
        review = await prisma.review.update({
          where: { id: existing.id },
          data: {
            rating: ratingNum,
            text: textValue,
            revieweeUserId,
          },
        });
      } else {
        try {
          review = await prisma.review.create({
            data: {
              jobId,
              reviewerUserId,
              revieweeUserId,
              rating: ratingNum,
              text: textValue,
            },
          });
        } catch (e: any) {
          const msg = String(e?.message ?? "");
          if (msg.toLowerCase().includes("unique") || msg.includes("jobId_reviewerUserId")) {
            return res.status(409).json({ error: "You have already reviewed this job." });
          }
          throw e;
        }
      }

      const ratingSummary = revieweeUserId === providerId ? await recomputeProviderRating(providerId) : null;

      await enqueueWebhookEvent({
        eventType,
        payload: {
          reviewId: review.id,
          jobId,
          jobTitle: job.title,
          reviewerUserId,
          revieweeUserId,
          acceptedBidId,
          rating: review.rating,
          text: review.text,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
          ratingSummary,
        },
      });

      return res.status(existing ? 200 : 201).json({
        message: existing ? "Review updated." : "Review created.",
        review,
        ratingSummary,
      });
    } catch (err) {
      logger.error("jobs.reviews_upsert_error", { message: String((err as any)?.message ?? err) });
      return res.status(500).json({ error: "Internal server error while creating/updating review." });
    }
  };
}
