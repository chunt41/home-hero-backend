import { prisma } from "./prisma";
import { startWebhookWorker } from "./webhooks/worker";
import { startBackgroundJobWorker } from "./jobs/worker";

async function main() {
  // DB ping before starting worker (same logic you had in server.ts)
  await prisma.$queryRaw`SELECT 1`;

  const stop = startWebhookWorker();
  console.log("[webhooks] worker started (dedicated worker service)");

  const stopJobs = startBackgroundJobWorker();
  console.log("[jobs] worker started (dedicated worker service)");

  const shutdown = async (signal: string) => {
    console.log(`[worker shutdown] received ${signal}`);
    try {
      stop?.();
      stopJobs?.();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[worker startup] failed:", e);
  process.exit(1);
});
