import { prisma } from "../src/prisma";
import { recomputeProviderStatsForAllProviders } from "../src/services/providerStats";

async function main() {
  const startedAt = Date.now();
  const result = await recomputeProviderStatsForAllProviders({ prisma });
  const statsCount = await prisma.providerStats.count();

  // eslint-disable-next-line no-console
  console.log({
    providersProcessed: result.providersProcessed,
    providerStatsRows: statsCount,
    elapsedMs: Date.now() - startedAt,
  });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("recompute failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
