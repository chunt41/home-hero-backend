import { prisma } from "../src/prisma";

async function main() {
  const job = await prisma.backgroundJob.create({
    data: {
      type: "PROVIDER_STATS_RECOMPUTE",
      payload: { scope: "ALL", reason: "manual_seed" },
      runAt: new Date(),
      maxAttempts: 3,
    },
  });

  // eslint-disable-next-line no-console
  console.log("enqueued", {
    id: job.id,
    type: job.type,
    runAt: job.runAt.toISOString(),
  });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("enqueue failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
