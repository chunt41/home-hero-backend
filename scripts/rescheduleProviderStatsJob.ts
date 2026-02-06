import { prisma } from "../src/prisma";
import { getNextDailyRunAtUtc } from "../src/services/providerStats";

async function main() {
  const now = new Date();
  const hourUtc = Number(process.env.PROVIDER_STATS_RECOMPUTE_HOUR_UTC ?? 4);
  const runAt = getNextDailyRunAtUtc({ now, hourUtc });

  const job = await prisma.backgroundJob.findFirst({
    where: { type: "PROVIDER_STATS_RECOMPUTE", status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: [{ id: "desc" }],
    select: { id: true },
  });

  if (!job) {
    const created = await prisma.backgroundJob.create({
      data: {
        type: "PROVIDER_STATS_RECOMPUTE",
        payload: { scope: "ALL", reason: "reschedule" },
        runAt,
        maxAttempts: 3,
      },
    });

    // eslint-disable-next-line no-console
    console.log("created", { id: created.id, runAt: created.runAt.toISOString() });
    return;
  }

  const updated = await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      runAt,
      attempts: 0,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      status: "PENDING",
    },
  });

  // eslint-disable-next-line no-console
  console.log("rescheduled", { id: updated.id, runAt: updated.runAt.toISOString() });
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("reschedule failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
