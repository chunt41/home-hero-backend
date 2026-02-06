import { prisma } from "../prisma";

export type EnqueueBackgroundJobInput = {
  type: string;
  payload: any;
  runAt?: Date;
  maxAttempts?: number;
};

export async function enqueueBackgroundJob(input: EnqueueBackgroundJobInput): Promise<void> {
  const { type, payload, runAt, maxAttempts } = input;

  try {
    await prisma.backgroundJob.create({
      data: {
        type,
        payload,
        runAt: runAt ?? new Date(),
        ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
      },
    });
  } catch (err) {
    // Deploy-safe: if the migration hasn't been applied yet, don't break the main flow.
    console.error("enqueueBackgroundJob failed:", (err as any)?.message ?? err);
  }
}
