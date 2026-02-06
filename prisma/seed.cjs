const fs = require("fs");
const path = require("path");

const dotenv = require("dotenv");

// Prefer Prisma-specific env file for seeding to avoid accidentally using prod settings in .env
const prismaEnvPath =
  process.env.PRISMA_ENV_PATH ||
  (fs.existsSync(path.join(process.cwd(), ".env.prisma")) ? ".env.prisma" : ".env");

dotenv.config({ path: prismaEnvPath, override: true });

const tls = require("tls");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const ca = fs.readFileSync(path.join(__dirname, "../certs/supabase-ca.crt"), "utf8");

const databaseUrl = process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_PRIVATE_URL or DATABASE_URL is required for seeding");
}

// Safety: refuse to seed against obvious pooler URLs (migrations/seeds should use direct DB host)
if (String(databaseUrl).includes("pooler.supabase.com")) {
  throw new Error(
    "Refusing to seed using a Supabase pooler URL. Use the direct host (db.<ref>.supabase.co) in .env.prisma."
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    ca,
    rejectUnauthorized: true,
  },
});


const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });


const bcrypt = require("bcryptjs");

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function sampleUnique(rng, arr, count) {
  const copy = [...arr];
  const out = [];
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

const DEV_SEED = {
  datasetKey: "home-hero-dev-seed-v1",
  emailDomain: "homehero.dev",
  userPassword: "DevUserPassphrase!2345",
  adminEmail: "sarah@example.com",
};

async function main() {
  // sanity check: if this fails, it's purely pg/TLS, not Prisma
  await pool.query("SELECT 1");

  // Seed admin user if not exists
  const adminEmail = DEV_SEED.adminEmail;
  const adminPassword = "DevAdminPassphrase!2345";
  const adminName = "Sarah Admin";
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: "ADMIN",
      },
    });
    console.log(`✅ Admin user created: ${adminEmail} / ${adminPassword}`);
  } else {
    console.log(`ℹ️  Admin user already exists: ${adminEmail}`);
  }

  const webhookUrl = "https://emailhook.site/d9478ee4-4f9a-473a-a057-cb5cd8027df2";
  const existingWebhook = await prisma.webhookEndpoint.findFirst({ where: { url: webhookUrl } });
  if (!existingWebhook) {
    await prisma.webhookEndpoint.create({
      data: {
        url: webhookUrl,
        secret: "dev_secret_123",
        enabled: true,
        events: ["bid.placed"],
      },
    });
    console.log("✅ Webhook endpoint seeded");
  } else {
    console.log("ℹ️  Webhook endpoint already exists");
  }

  const rng = mulberry32(hashSeed(DEV_SEED.datasetKey));

  // If we already have DEV SEED jobs, don't duplicate the dataset.
  const existingSeedJob = await prisma.job.findFirst({
    where: { title: { startsWith: "DEV SEED:" } },
    select: { id: true },
  });
  if (existingSeedJob) {
    console.log("ℹ️  DEV SEED dataset already present (jobs exist). Skipping dataset creation.");
    console.log("    If you want a fresh dataset, clear the dev DB and re-run `npx prisma db seed`. ");
    return;
  }

  // --- Categories ---
  const categories = [
    { name: "Plumbing", slug: "plumbing" },
    { name: "Electrical", slug: "electrical" },
    { name: "Handyman", slug: "handyman" },
    { name: "Cleaning", slug: "cleaning" },
    { name: "Lawn & Garden", slug: "lawn-garden" },
    { name: "Painting", slug: "painting" },
    { name: "HVAC", slug: "hvac" },
    { name: "Moving", slug: "moving" },
    { name: "Roofing", slug: "roofing" },
    { name: "Carpentry", slug: "carpentry" },
  ];

  await prisma.category.createMany({ data: categories, skipDuplicates: true });
  const categoryRows = await prisma.category.findMany({ select: { id: true, slug: true, name: true } });
  const categoryBySlug = new Map(categoryRows.map((c) => [c.slug, c]));

  // --- Users (Consumers & Providers) ---
  const consumerNames = ["Alex", "Jordan", "Taylor", "Casey", "Morgan", "Riley"];
  const providerNames = [
    "Pat", "Jamie", "Avery", "Cameron", "Quinn", "Rowan", "Dakota", "Reese", "Skyler", "Parker", "Sage", "Drew",
  ];

  const cities = ["San Francisco, CA", "Oakland, CA", "San Jose, CA", "Berkeley, CA", "Daly City, CA", "Alameda, CA"];
  const zipCodes = ["94107", "94110", "94103", "94607", "94612", "94704", "95112", "94014"]; 

  const sharedPasswordHash = await bcrypt.hash(DEV_SEED.userPassword, 10);

  async function upsertUser({ role, name, email, location, phone }) {
    return prisma.user.upsert({
      where: { email },
      update: { role, name, location, phone },
      create: {
        role,
        name,
        email,
        passwordHash: sharedPasswordHash,
        location,
        phone,
      },
      select: { id: true, email: true, name: true, role: true },
    });
  }

  const consumers = [];
  for (let i = 0; i < consumerNames.length; i++) {
    const name = `${consumerNames[i]} Consumer`;
    const email = `dev-consumer-${i + 1}@${DEV_SEED.emailDomain}`;
    const location = pick(rng, cities);
    consumers.push(
      await upsertUser({
        role: "CONSUMER",
        name,
        email,
        location,
        phone: `+1555000${100 + i}`,
      })
    );
  }

  const providers = [];
  for (let i = 0; i < providerNames.length; i++) {
    const name = `${providerNames[i]} Provider`;
    const email = `dev-provider-${i + 1}@${DEV_SEED.emailDomain}`;
    const location = pick(rng, cities);
    providers.push(
      await upsertUser({
        role: "PROVIDER",
        name,
        email,
        location,
        phone: `+1555111${100 + i}`,
      })
    );
  }

  // --- Provider subscription/profile/stats/entitlement ---
  const proProviderIds = new Set(sampleUnique(rng, providers.map((p) => p.id), 3));
  const basicProviderIds = new Set(
    sampleUnique(
      rng,
      providers.map((p) => p.id).filter((id) => !proProviderIds.has(id)),
      4
    )
  );

  for (const p of providers) {
    const tier = proProviderIds.has(p.id) ? "PRO" : basicProviderIds.has(p.id) ? "BASIC" : "FREE";
    await prisma.subscription.upsert({
      where: { userId: p.id },
      update: { tier, renewsAt: tier === "FREE" ? null : addDays(new Date(), 30) },
      create: { userId: p.id, tier, renewsAt: tier === "FREE" ? null : addDays(new Date(), 30) },
    });

    const pickedCats = sampleUnique(rng, categories, randInt(rng, 2, 4)).map((c) => categoryBySlug.get(c.slug)).filter(Boolean);
    await prisma.providerProfile.upsert({
      where: { providerId: p.id },
      update: {
        experience: pick(rng, ["2 years", "5 years", "10+ years"]),
        specialties: pickedCats.map((c) => c.name).join(", "),
        verificationBadge: tier === "PRO",
        featuredZipCodes: tier === "PRO" ? sampleUnique(rng, zipCodes, 2) : [],
        categories: {
          set: pickedCats.map((c) => ({ id: c.id })),
        },
      },
      create: {
        providerId: p.id,
        experience: pick(rng, ["2 years", "5 years", "10+ years"]),
        specialties: pickedCats.map((c) => c.name).join(", "),
        verificationBadge: tier === "PRO",
        featuredZipCodes: tier === "PRO" ? sampleUnique(rng, zipCodes, 2) : [],
        categories: { connect: pickedCats.map((c) => ({ id: c.id })) },
      },
    });

    await prisma.providerEntitlement.upsert({
      where: { providerId: p.id },
      update: {
        verificationBadge: tier === "PRO",
        featuredZipCodes: tier === "PRO" ? sampleUnique(rng, zipCodes, 2) : [],
        leadCredits: tier === "PRO" ? 15 : tier === "BASIC" ? 6 : 0,
      },
      create: {
        providerId: p.id,
        verificationBadge: tier === "PRO",
        featuredZipCodes: tier === "PRO" ? sampleUnique(rng, zipCodes, 2) : [],
        leadCredits: tier === "PRO" ? 15 : tier === "BASIC" ? 6 : 0,
      },
    });

    await prisma.providerStats.upsert({
      where: { providerId: p.id },
      update: {
        ratingCount: 0,
        jobsCompletedAllTime: 0,
        jobsCompleted30d: 0,
        cancellationRate30d: 0,
        disputeRate30d: 0,
        reportRate30d: 0,
      },
      create: {
        providerId: p.id,
        ratingCount: 0,
        jobsCompletedAllTime: 0,
        jobsCompleted30d: 0,
        cancellationRate30d: 0,
        disputeRate30d: 0,
        reportRate30d: 0,
      },
    });
  }

  // --- Saved searches ---
  for (const p of providers) {
    const shouldHaveSearch = rng() < 0.7;
    if (!shouldHaveSearch) continue;
    const catSlugs = sampleUnique(rng, categories, randInt(rng, 1, 3)).map((c) => c.slug);
    const zipCode = pick(rng, zipCodes);
    await prisma.providerSavedSearch.create({
      data: {
        providerId: p.id,
        categories: catSlugs,
        radiusMiles: pick(rng, [10, 15, 25, 40]),
        zipCode,
        minBudget: rng() < 0.5 ? null : pick(rng, [50, 100, 150]),
        maxBudget: rng() < 0.3 ? null : pick(rng, [250, 400, 600, 900]),
        isEnabled: true,
      },
    });
  }

  // --- Jobs, bids, messages ---
  const jobTemplates = [
    { title: "Fix a leaking faucet", category: "plumbing" },
    { title: "Install a ceiling fan", category: "electrical" },
    { title: "Deep clean apartment", category: "cleaning" },
    { title: "Mow lawn and trim bushes", category: "lawn-garden" },
    { title: "Paint a bedroom", category: "painting" },
    { title: "Repair roof leak", category: "roofing" },
    { title: "Move a couch and boxes", category: "moving" },
    { title: "Replace thermostat", category: "hvac" },
    { title: "Assemble furniture", category: "handyman" },
    { title: "Fix a sticking door", category: "carpentry" },
  ];

  const now = new Date();
  const jobsToCreate = 30;
  const createdJobs = [];

  for (let i = 0; i < jobsToCreate; i++) {
    const template = pick(rng, jobTemplates);
    const consumer = pick(rng, consumers);
    const budgetMin = pick(rng, [50, 75, 100, 150]);
    const budgetMax = budgetMin + pick(rng, [75, 150, 250, 400]);
    const createdAt = addDays(now, -randInt(rng, 0, 20));

    const statusRoll = rng();
    let status = "OPEN";
    if (statusRoll < 0.55) status = "OPEN";
    else if (statusRoll < 0.80) status = "IN_PROGRESS";
    else if (statusRoll < 0.93) status = "COMPLETED_PENDING_CONFIRMATION";
    else status = "COMPLETED";

    const location = pick(rng, cities);
    const job = await prisma.job.create({
      data: {
        consumerId: consumer.id,
        title: `DEV SEED: ${template.title} (#${i + 1})`,
        description: `Seeded dev job for ${template.title.toLowerCase()}. Looking for a reliable pro.`,
        budgetMin,
        budgetMax,
        status,
        location,
        category: categoryBySlug.get(template.category)?.name ?? template.category,
        trade: categoryBySlug.get(template.category)?.name ?? template.category,
        urgency: pick(rng, ["low", "normal", "high"]),
        suggestedTags: [template.category],
        createdAt,
      },
      select: { id: true, consumerId: true, status: true, title: true },
    });
    createdJobs.push(job);

    // Create 1-4 bids from distinct providers
    const bidProviderIds = sampleUnique(rng, providers.map((p) => p.id), randInt(rng, 1, 4));
    const bidIds = [];
    for (const providerId of bidProviderIds) {
      const amount = randInt(rng, budgetMin, budgetMax);
      const bid = await prisma.bid.create({
        data: {
          jobId: job.id,
          providerId,
          amount,
          message: `I can help with this. Estimate: $${amount}. Available ${pick(rng, ["tomorrow", "this weekend", "next week"])}.`,
          status: "PENDING",
        },
        select: { id: true, providerId: true },
      });
      bidIds.push(bid);
    }

    // If the job is awarded-ish, accept one bid and attach awardedProviderId.
    if (job.status !== "OPEN") {
      const accepted = pick(rng, bidIds);
      await prisma.bid.update({ where: { id: accepted.id }, data: { status: "ACCEPTED" } });
      const declined = bidIds.filter((b) => b.id !== accepted.id);
      for (const d of declined) {
        if (rng() < 0.6) {
          await prisma.bid.update({ where: { id: d.id }, data: { status: "DECLINED" } });
        }
      }

      const awardTime = addDays(createdAt, randInt(rng, 0, 3));
      let completionPendingForUserId = null;
      let completedAt = null;
      if (job.status === "COMPLETED_PENDING_CONFIRMATION") {
        completionPendingForUserId = rng() < 0.5 ? accepted.providerId : job.consumerId;
        completedAt = null;
      }
      if (job.status === "COMPLETED") {
        completionPendingForUserId = null;
        completedAt = addDays(awardTime, randInt(rng, 1, 5));
      }

      await prisma.job.update({
        where: { id: job.id },
        data: {
          awardedProviderId: accepted.providerId,
          awardedAt: awardTime,
          completionPendingForUserId,
          completedAt,
        },
      });

      // Messages between consumer/provider for non-open jobs
      const messageCount = randInt(rng, 6, 16);
      const participants = [job.consumerId, accepted.providerId];
      let senderId = pick(rng, participants);
      for (let m = 0; m < messageCount; m++) {
        senderId = senderId === participants[0] ? participants[1] : participants[0];
        await prisma.message.create({
          data: {
            jobId: job.id,
            senderId,
            text: pick(rng, [
              "Thanks for reaching out — what’s your availability?",
              "I can swing by for an estimate.",
              "Do you have photos of the issue?",
              "Yes, that works for me.",
              "I’m on my way.",
              "Job is done — please take a look.",
              "Looks good — thank you!",
            ]),
            createdAt: addDays(awardTime, m * 0.1),
          },
        });
      }

      // Read states for both parties
      for (const uid of participants) {
        await prisma.jobMessageReadState.upsert({
          where: { jobId_userId: { jobId: job.id, userId: uid } },
          update: { lastReadAt: addDays(awardTime, 1) },
          create: { jobId: job.id, userId: uid, lastReadAt: addDays(awardTime, 1) },
        });
      }

      // A couple notifications
      await prisma.notification.createMany({
        data: [
          {
            userId: job.consumerId,
            type: "JOB_AWARDED",
            content: { jobId: job.id, providerId: accepted.providerId },
          },
          {
            userId: accepted.providerId,
            type: "BID_ACCEPTED",
            content: { jobId: job.id, consumerId: job.consumerId },
          },
        ],
      });
    }
  }

  // --- Job matches + favorites ---
  const openJobs = createdJobs.filter((j) => j.status === "OPEN");
  for (const j of openJobs) {
    const candidateProviders = sampleUnique(rng, providers, 3);
    for (const p of candidateProviders) {
      await prisma.jobMatchNotification.create({
        data: {
          jobId: j.id,
          providerId: p.id,
          score: Math.round((0.6 + rng() * 0.35) * 100) / 100,
        },
      });
    }
  }

  // Consumer favorites
  for (const c of consumers) {
    const favoriteProviders = sampleUnique(rng, providers, 3);
    for (const p of favoriteProviders) {
      await prisma.favoriteProvider.create({ data: { consumerId: c.id, providerId: p.id } });
    }
  }

  console.log("✅ DEV SEED dataset created");
  console.log(`🔑 Dev user password (consumers/providers): ${DEV_SEED.userPassword}`);
  console.log(`👤 Example consumer: dev-consumer-1@${DEV_SEED.emailDomain}`);
  console.log(`👤 Example provider: dev-provider-1@${DEV_SEED.emailDomain}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
