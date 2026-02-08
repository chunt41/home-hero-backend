import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { createGetProvidersSearchHandler } from "./providersSearch";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

type SeedProfile = any;

function makeProfile(seed: {
  providerId: number;
  location: string | null;
  avgRating: number | null;
  ratingCount: number;
  reviewCount?: number;
  verificationStatus?: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  categories?: Array<{ id: number; name: string; slug: string }>;
  tier?: string;
  jobsCompletedAllTime?: number;
  medianResponseTimeSeconds30d?: number | null;
}) {
  return {
    experience: null,
    specialties: null,
    rating: seed.avgRating,
    reviewCount: seed.reviewCount ?? seed.ratingCount,
    verificationBadge: false,
    featuredZipCodes: [],
    categories: seed.categories ?? [],
    provider: {
      id: seed.providerId,
      name: `P${seed.providerId}`,
      location: seed.location,
      role: "PROVIDER",
      isSuspended: false,
      subscription: { tier: seed.tier ?? "FREE" },
      providerStats: {
        avgRating: seed.avgRating,
        ratingCount: seed.ratingCount,
        jobsCompletedAllTime: seed.jobsCompletedAllTime ?? 0,
        jobsCompleted30d: 0,
        medianResponseTimeSeconds30d: seed.medianResponseTimeSeconds30d ?? null,
      },
      providerEntitlement: {
        verificationBadge: false,
        featuredZipCodes: [],
      },
      providerVerification: {
        status: seed.verificationStatus ?? "NONE",
      },
    },
  } satisfies SeedProfile;
}

function makePrismaStub(seed: {
  profiles: SeedProfile[];
  favoritesByConsumer?: Record<number, number[]>;
}) {
  function hasCategory(profile: any, slugs: string[]) {
    if (!Array.isArray(slugs) || slugs.length === 0) return true;
    const cats = profile.categories ?? [];
    return cats.some((c: any) => slugs.includes(String(c.slug)));
  }

  function isVerified(profile: any) {
    return profile?.provider?.providerVerification?.status === "VERIFIED";
  }

  function getMinRating(where: any): number | null {
    const or = where?.OR;
    if (!Array.isArray(or)) return null;
    // handler builds: [{ provider: { providerStats: { is: { avgRating: { gte }}}}}, { rating: { gte }}]
    const gte1 = or?.[0]?.provider?.providerStats?.is?.avgRating?.gte;
    const gte2 = or?.[1]?.rating?.gte;
    const gte = typeof gte1 === "number" ? gte1 : typeof gte2 === "number" ? gte2 : null;
    return typeof gte === "number" ? gte : null;
  }

  function getMinCompleted(where: any): number | null {
    const gte = where?.provider?.providerStats?.is?.jobsCompletedAllTime?.gte;
    return typeof gte === "number" ? gte : null;
  }

  return {
    providerProfile: {
      findMany: async (args: any) => {
        const where = args?.where ?? {};
        const categorySlugs: string[] = where?.categories?.some?.slug?.in ?? [];
        const requireVerified = Boolean(where?.provider?.providerVerification);
        const minRating = getMinRating(where);
        const minCompleted = getMinCompleted(where);

        return seed.profiles
          .filter((p) => hasCategory(p, categorySlugs))
          .filter((p) => (requireVerified ? isVerified(p) : true))
          .filter((p) => (typeof minRating === "number" ? Number(p?.provider?.providerStats?.avgRating ?? p.rating ?? 0) >= minRating : true))
          .filter((p) => (typeof minCompleted === "number" ? Number(p?.provider?.providerStats?.jobsCompletedAllTime ?? 0) >= minCompleted : true));
      },
    },
    favoriteProvider: {
      findMany: async (args: any) => {
        const consumerId = args?.where?.consumerId;
        const inIds: number[] = args?.where?.providerId?.in ?? [];
        const favs = seed.favoritesByConsumer?.[consumerId] ?? [];
        return favs.filter((id) => inIds.includes(id)).map((providerId) => ({ providerId }));
      },
    },
  };
}

test("GET /providers/search filters verifiedOnly", async (t) => {
  const prev = process.env.RATE_LIMIT_REDIS_URL;
  process.env.RATE_LIMIT_REDIS_URL = "";
  t.after(() => {
    process.env.RATE_LIMIT_REDIS_URL = prev;
  });

  const prisma = makePrismaStub({
    profiles: [
      makeProfile({ providerId: 10, location: "San Francisco, CA 94105", avgRating: 4.8, ratingCount: 10, verificationStatus: "VERIFIED" }),
      makeProfile({ providerId: 11, location: "San Francisco, CA 94105", avgRating: 4.9, ratingCount: 20, verificationStatus: "NONE" }),
    ],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/providers/search", createGetProvidersSearchHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/providers/search?zip=94105&radiusMiles=25&verifiedOnly=true&limit=50`);
  assert.equal(res.status, 200);
  const body: any = await res.json();

  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, 10);
  assert.equal(body.items[0].isVerified, true);
});

test("GET /providers/search filters by radius and drops unknown-distance providers", async (t) => {
  const prev = process.env.RATE_LIMIT_REDIS_URL;
  process.env.RATE_LIMIT_REDIS_URL = "";
  t.after(() => {
    process.env.RATE_LIMIT_REDIS_URL = prev;
  });

  const prisma = makePrismaStub({
    profiles: [
      makeProfile({ providerId: 20, location: "San Francisco, CA 94105", avgRating: 4.0, ratingCount: 10 }),
      makeProfile({ providerId: 21, location: "New York, NY 10001", avgRating: 5.0, ratingCount: 50 }),
      makeProfile({ providerId: 22, location: "Somewhere", avgRating: 5.0, ratingCount: 50 }),
    ],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/providers/search", createGetProvidersSearchHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/providers/search?zip=94105&radiusMiles=10&limit=50`);
  assert.equal(res.status, 200);
  const body: any = await res.json();

  const ids = body.items.map((x: any) => x.id);
  assert.deepEqual(ids, [20]);
});

test("GET /providers/search sort=distance is deterministic (tie-breaker providerId DESC)", async (t) => {
  const prev = process.env.RATE_LIMIT_REDIS_URL;
  process.env.RATE_LIMIT_REDIS_URL = "";
  t.after(() => {
    process.env.RATE_LIMIT_REDIS_URL = prev;
  });

  const prisma = makePrismaStub({
    profiles: [
      makeProfile({ providerId: 30, location: "San Francisco, CA 94105", avgRating: 4.0, ratingCount: 10 }),
      makeProfile({ providerId: 31, location: "San Francisco, CA 94105", avgRating: 3.0, ratingCount: 10 }),
      makeProfile({ providerId: 32, location: "San Francisco, CA 94107", avgRating: 5.0, ratingCount: 10 }),
    ],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/providers/search", createGetProvidersSearchHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/providers/search?zip=94105&radiusMiles=100&sort=distance&limit=50`);
  assert.equal(res.status, 200);
  const body: any = await res.json();

  // 94105 providers have distance 0, ordered by id DESC among themselves.
  // 94107 is non-zero, comes after.
  const ids = body.items.map((x: any) => x.id);
  assert.deepEqual(ids.slice(0, 2), [31, 30]);
  assert.equal(ids[2], 32);
});

test("GET /providers/search cursor pagination returns stable continuation", async (t) => {
  const prev = process.env.RATE_LIMIT_REDIS_URL;
  process.env.RATE_LIMIT_REDIS_URL = "";
  t.after(() => {
    process.env.RATE_LIMIT_REDIS_URL = prev;
  });

  const prisma = makePrismaStub({
    profiles: [
      makeProfile({ providerId: 40, location: "San Francisco, CA 94105", avgRating: 5.0, ratingCount: 200 }),
      makeProfile({ providerId: 41, location: "San Francisco, CA 94105", avgRating: 4.7, ratingCount: 50 }),
      makeProfile({ providerId: 42, location: "San Francisco, CA 94105", avgRating: 4.2, ratingCount: 10 }),
    ],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/providers/search", createGetProvidersSearchHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const firstRes = await fetch(`${baseUrl}/providers/search?zip=94105&radiusMiles=25&sort=rating&limit=1`);
  assert.equal(firstRes.status, 200);
  const firstBody: any = await firstRes.json();
  assert.equal(firstBody.items.length, 1);
  assert.ok(firstBody.pageInfo.nextCursor);

  const firstId = firstBody.items[0].id;

  const secondRes = await fetch(
    `${baseUrl}/providers/search?zip=94105&radiusMiles=25&sort=rating&limit=1&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`
  );
  assert.equal(secondRes.status, 200);
  const secondBody: any = await secondRes.json();

  assert.equal(secondBody.items.length, 1);
  const secondId = secondBody.items[0].id;
  assert.notEqual(secondId, firstId);
});

test("GET /providers/search returns sanitized whyShown (no raw scoreBreakdown for consumers)", async (t) => {
  const prev = process.env.RATE_LIMIT_REDIS_URL;
  process.env.RATE_LIMIT_REDIS_URL = "";
  t.after(() => {
    process.env.RATE_LIMIT_REDIS_URL = prev;
  });

  const prisma = makePrismaStub({
    profiles: [
      makeProfile({
        providerId: 50,
        location: "San Francisco, CA 94105",
        avgRating: 4.6,
        ratingCount: 12,
        verificationStatus: "VERIFIED",
        tier: "PRO",
        medianResponseTimeSeconds30d: 180,
      }),
    ],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { userId: 1, role: "CONSUMER" };
    next();
  });
  app.get("/providers/search", createGetProvidersSearchHandler({ prisma: prisma as any }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/providers/search?zip=94105&radiusMiles=25&limit=10`);
  assert.equal(res.status, 200);
  const body: any = await res.json();

  assert.equal(body.items.length, 1);
  const item = body.items[0];

  assert.ok(item.whyShown);
  assert.equal(item.whyShown.isVerified, true);
  assert.equal(item.whyShown.rating, 4.6);
  assert.equal(item.whyShown.ratingCount, 12);
  assert.equal(item.whyShown.responseTimeSeconds30d, 180);
  assert.ok(String(item.whyShown.tierBoost).toLowerCase().includes("pro"));

  assert.equal(item.scoreBreakdown, undefined);
});
