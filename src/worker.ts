import { prisma } from "./prisma";
import { startWebhookWorker } from "./webhooks/worker";
import { startBackgroundJobWorker } from "./jobs/worker";
import { logger } from "./services/logger";
import { initSentry, captureException, flushSentry } from "./observability/sentry";

async function main() {
  // DB ping before starting worker (same logic you had in server.ts)
  await prisma.$queryRaw`SELECT 1`;

  await initSentry().catch(() => null);

  const stop = startWebhookWorker();
  logger.info("worker.started", { worker: "webhooks" });

  const stopJobs = startBackgroundJobWorker();
  logger.info("worker.started", { worker: "jobs" });

  const shutdown = async (signal: string) => {
    logger.info("worker.shutdown_signal", { signal });
    try {
      stop?.();
      stopJobs?.();
      await prisma.$disconnect();
      await flushSentry().catch(() => null);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", async (err) => {
    logger.error("process.uncaughtException", { message: String((err as any)?.message ?? err) });
    captureException(err, { kind: "uncaughtException" });
    await flushSentry().catch(() => null);
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", async (reason) => {
    logger.error("process.unhandledRejection", { message: String((reason as any)?.message ?? reason) });
    captureException(reason, { kind: "unhandledRejection" });
    await flushSentry().catch(() => null);
    shutdown("unhandledRejection");
  });
}

main().catch((e) => {
  logger.error("worker.startup_failed", { message: String((e as any)?.message ?? e) });
  process.exit(1);
});
