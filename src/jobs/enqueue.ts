import { prisma } from "../prisma";
import { getLogContext } from "../services/logContext";
import { logger } from "../services/logger";

export type EnqueueBackgroundJobInput = {
  type: string;
  payload: any;
  runAt?: Date;
  maxAttempts?: number;
  requestId?: string;
};

export async function enqueueBackgroundJob(input: EnqueueBackgroundJobInput): Promise<void> {
  const { type, payload, runAt, maxAttempts } = input;

  const ctxRequestId = input.requestId ?? getLogContext()?.requestId;
  const finalPayload =
    ctxRequestId && payload && typeof payload === "object" && !Array.isArray(payload) && payload.requestId == null
      ? { ...payload, requestId: ctxRequestId }
      : payload;

  try {
    await prisma.backgroundJob.create({
      data: {
        type,
        payload: finalPayload,
        runAt: runAt ?? new Date(),
        ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      },
    });
  } catch (err) {
    // Deploy-safe: if the migration hasn't been applied yet, don't break the main flow.
    logger.error("jobs.enqueue_failed", { message: String((err as any)?.message ?? err), type });
  }
}
