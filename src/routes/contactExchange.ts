import type { RequestHandler } from "express";
import { z } from "zod";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthedRequest = {
  user?: {
    userId: number;
    role: UserRole;
  };
};

type PrismaClientLike = {
  job: {
    findUnique: (args: any) => Promise<any>;
  };
  contactExchangeRequest: {
    findFirst: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  user: {
    findUnique: (args: any) => Promise<any>;
  };
};

const jobIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const decideBodySchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

const COOLDOWN_MS_DEFAULT = 10 * 60_000;

function isAdmin(req: AuthedRequest) {
  return req.user?.role === "ADMIN";
}

function otherParticipant(job: { consumerId: number; awardedProviderId: number }, actorId: number): number {
  return actorId === job.consumerId ? job.awardedProviderId : job.consumerId;
}

export function createPostContactExchangeRequestHandler(deps: {
  prisma: PrismaClientLike;
  cooldownMs?: number;
  logSecurityEvent?: (req: any, actionType: string, metadata?: Record<string, unknown>) => Promise<void>;
}): RequestHandler {
  const { prisma, cooldownMs = COOLDOWN_MS_DEFAULT, logSecurityEvent } = deps;

  return async (req: any, res) => {
    const authed = req as AuthedRequest;
    if (!authed.user) return res.status(401).json({ error: "Not authenticated" });

    const parsedParams = jobIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) return res.status(400).json({ error: "Invalid job id" });
    const jobId = parsedParams.data.id;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        awardedProviderId: true,
        status: true,
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const awardedProviderId = job.awardedProviderId as number | null;
    if (typeof awardedProviderId !== "number") {
      return res.status(400).json({
        error: "Contact exchange is only available after a provider is awarded.",
        code: "CONTACT_EXCHANGE_NOT_AVAILABLE",
      });
    }

    const actorId = authed.user.userId;
    const isParticipant = actorId === job.consumerId || actorId === awardedProviderId;
    if (!isParticipant && !isAdmin(authed)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const pending = await prisma.contactExchangeRequest.findFirst({
      where: { jobId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, requestedByUserId: true, status: true, createdAt: true },
    });

    if (pending) {
      return res.status(409).json({
        error: "A contact exchange request is already pending.",
        code: "CONTACT_EXCHANGE_ALREADY_PENDING",
        request: pending,
      });
    }

    const lastByActor = await prisma.contactExchangeRequest.findFirst({
      where: { jobId, requestedByUserId: actorId },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, status: true },
    });

    if (lastByActor?.createdAt) {
      const ageMs = Date.now() - new Date(lastByActor.createdAt).getTime();
      if (ageMs >= 0 && ageMs < cooldownMs) {
        const retryAfterSeconds = Math.ceil((cooldownMs - ageMs) / 1000);
        return res.status(429).json({
          error: "Please wait a bit before requesting contact exchange again.",
          code: "CONTACT_EXCHANGE_COOLDOWN",
          retryAfterSeconds,
        });
      }
    }

    const created = await prisma.contactExchangeRequest.create({
      data: {
        jobId,
        requestedByUserId: actorId,
        status: "PENDING",
      },
      select: {
        id: true,
        jobId: true,
        requestedByUserId: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    });

    const otherUserId = otherParticipant({ consumerId: job.consumerId, awardedProviderId }, actorId);

    await logSecurityEvent?.(req, "contact_exchange.requested", {
      targetType: "JOB",
      targetId: String(jobId),
      jobId,
      requestedByUserId: actorId,
      otherUserId,
      jobStatus: job.status,
      requestId: created.id,
    });

    return res.status(201).json({ request: created });
  };
}

export function createPostContactExchangeDecideHandler(deps: {
  prisma: PrismaClientLike;
  logSecurityEvent?: (req: any, actionType: string, metadata?: Record<string, unknown>) => Promise<void>;
}): RequestHandler {
  const { prisma, logSecurityEvent } = deps;

  return async (req: any, res) => {
    const authed = req as AuthedRequest;
    if (!authed.user) return res.status(401).json({ error: "Not authenticated" });

    const parsedParams = jobIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) return res.status(400).json({ error: "Invalid job id" });
    const jobId = parsedParams.data.id;

    const parsedBody = decideBodySchema.safeParse(req.body);
    if (!parsedBody.success) return res.status(400).json({ error: "Invalid body", details: parsedBody.error.flatten() });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        awardedProviderId: true,
        status: true,
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const awardedProviderId = job.awardedProviderId as number | null;
    if (typeof awardedProviderId !== "number") {
      return res.status(400).json({
        error: "Contact exchange is only available after a provider is awarded.",
        code: "CONTACT_EXCHANGE_NOT_AVAILABLE",
      });
    }

    const actorId = authed.user.userId;
    const isParticipant = actorId === job.consumerId || actorId === awardedProviderId;
    if (!isParticipant && !isAdmin(authed)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const pending = await prisma.contactExchangeRequest.findFirst({
      where: {
        jobId,
        status: "PENDING",
        requestedByUserId: { not: actorId },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        jobId: true,
        requestedByUserId: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    });

    if (!pending) {
      return res.status(404).json({
        error: "No pending contact exchange request to decide.",
        code: "CONTACT_EXCHANGE_NOT_PENDING",
      });
    }

    const nextStatus = parsedBody.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";

    const updated = await prisma.contactExchangeRequest.update({
      where: { id: pending.id },
      data: { status: nextStatus, decidedAt: new Date() },
      select: {
        id: true,
        jobId: true,
        requestedByUserId: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    });

    await logSecurityEvent?.(req, "contact_exchange.decided", {
      targetType: "JOB",
      targetId: String(jobId),
      jobId,
      decidedByUserId: actorId,
      requestedByUserId: updated.requestedByUserId,
      status: updated.status,
      jobStatus: job.status,
      requestId: updated.id,
    });

    return res.json({ request: updated });
  };
}

export function createGetContactExchangeHandler(deps: {
  prisma: PrismaClientLike;
}): RequestHandler {
  const { prisma } = deps;

  return async (req: any, res) => {
    const authed = req as AuthedRequest;
    if (!authed.user) return res.status(401).json({ error: "Not authenticated" });

    const parsedParams = jobIdParamsSchema.safeParse(req.params);
    if (!parsedParams.success) return res.status(400).json({ error: "Invalid job id" });
    const jobId = parsedParams.data.id;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        awardedProviderId: true,
        status: true,
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found" });

    const awardedProviderId = job.awardedProviderId as number | null;

    const actorId = authed.user.userId;

    const isParticipant =
      actorId === job.consumerId ||
      (typeof awardedProviderId === "number" && actorId === awardedProviderId);

    if (!isParticipant && !isAdmin(authed)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const latest = await prisma.contactExchangeRequest.findFirst({
      where: { jobId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        requestedByUserId: true,
        status: true,
        createdAt: true,
        decidedAt: true,
      },
    });

    const approved = await prisma.contactExchangeRequest.findFirst({
      where: { jobId, status: "APPROVED" },
      orderBy: { decidedAt: "desc" },
      select: { id: true },
    });

    const isApproved = !!approved;

    if (!isApproved || typeof awardedProviderId !== "number") {
      return res.json({
        approved: false,
        jobId,
        jobStatus: job.status,
        request: latest,
      });
    }

    const [consumer, provider] = await Promise.all([
      prisma.user.findUnique({
        where: { id: job.consumerId },
        select: { id: true, name: true, email: true, phone: true },
      }),
      prisma.user.findUnique({
        where: { id: awardedProviderId },
        select: { id: true, name: true, email: true, phone: true },
      }),
    ]);

    return res.json({
      approved: true,
      jobId,
      jobStatus: job.status,
      request: latest,
      contact: {
        consumer: consumer ? { id: consumer.id, name: consumer.name, email: consumer.email, phone: consumer.phone } : null,
        provider: provider ? { id: provider.id, name: provider.name, email: provider.email, phone: provider.phone } : null,
      },
    });
  };
}
