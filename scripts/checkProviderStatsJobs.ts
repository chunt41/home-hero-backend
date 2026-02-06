import { prisma } from "../src/prisma";

async function main() {
  const jobs = await prisma.backgroundJob.findMany({
    where: { type: "PROVIDER_STATS_RECOMPUTE" },
    orderBy: [{ id: "desc" }],
    take: 5,
  });

  const statsCount = await prisma.providerStats.count();

  // eslint-disable-next-line no-console
  console.log({
    providerStatsCount: statsCount,
    jobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      attempts: j.attempts,
      runAt: j.runAt.toISOString(),
      lockedAt: j.lockedAt ? j.lockedAt.toISOString() : null,
      lockedBy: j.lockedBy,
      lastError: j.lastError,
      updatedAt: j.updatedAt.toISOString(),
    })),
  });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("check failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
