import type { RequestHandler } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import zipcodes from "zipcodes";

import { extractZip5, rankProvider, type ProviderRankingBreakdown } from "../matching/rankProviders";
import { normalizeZipForBoost } from "../services/providerDiscoveryRanking";
import { ensureSharedRedisConnected, getSharedRedisUrlOrNull } from "../services/sharedRedisClient";

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthedRequest = {
  user?: {
    userId: number;
    role: UserRole;
  };
};

type PrismaClientLike = {
  providerProfile: {
    findMany: (args: any) => Promise<any[]>;
  };
  favoriteProvider?: {
    findMany: (args: any) => Promise<Array<{ providerId: number }>>;
  };
};

export const providersSearchQuerySchema = z.object({
  zip: z.string().trim().min(1, "zip is required"),
  radiusMiles: z.coerce.number().int().min(1).max(100).default(25),
  categories: z
    .string()
    .trim()
    .optional()
    .transform((v) => {
      if (!v) return [] as string[];
      return v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }),
  minRating: z.coerce.number().min(0).max(5).optional(),
  minCompletedJobs: z.coerce.number().int().min(0).optional(),
  verifiedOnly: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  sort: z.enum(["relevance", "rating", "distance", "responseTime"]).default("relevance"),
  cursor: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type SortMode = z.infer<typeof providersSearchQuerySchema>["sort"];

type ProviderCard = {
  id: number;
  name: string | null;
  location: string | null;
  experience: string | null;
  specialties: string | null;
  rating: number | null;
  reviewCount: number;
  verificationStatus: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  isVerified: boolean;
  categories: Array<{ id: number; name: string; slug: string }>;
  stats: {
    avgRating: number | null;
    ratingCount: number;
    jobsCompletedAllTime: number;
    jobsCompleted30d: number;
    medianResponseTimeSeconds30d: number | null;
  } | null;
};

type SearchItem = {
  provider: ProviderCard;
  distanceMiles: number | null;
  scoreBreakdown: ProviderRankingBreakdown;
  // Fields for cursoring
  _score: number;
  _avgRating: number;
  _ratingCount: number;
  _distance: number; // Infinity if unknown
  _response: number; // Infinity if unknown
};

type CursorV1 =
  | {
      v: 1;
      sort: "relevance";
      score: number;
      id: number;
    }
  | {
      v: 1;
      sort: "rating";
      rating: number;
      ratingCount: number;
      id: number;
    }
  | {
      v: 1;
      sort: "distance";
      distanceMiles: number | null;
      id: number;
    }
  | {
      v: 1;
      sort: "responseTime";
      responseTimeSeconds: number | null;
      id: number;
    };

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function safeParseCursor(sort: SortMode, cursor?: string): CursorV1 | null {
  if (!cursor) return null;
  try {
    const raw = JSON.parse(base64UrlDecode(cursor));
    if (!raw || raw.v !== 1) return null;
    if (raw.sort !== sort) return null;
    return raw as CursorV1;
  } catch {
    return null;
  }
}

function makeCursor(sort: SortMode, item: SearchItem): CursorV1 {
  if (sort === "relevance") return { v: 1, sort, score: item._score, id: item.provider.id };
  if (sort === "rating") {
    return {
      v: 1,
      sort,
      rating: item._avgRating,
      ratingCount: item._ratingCount,
      id: item.provider.id,
    };
  }
  if (sort === "distance") {
    return {
      v: 1,
      sort,
      distanceMiles: item.distanceMiles,
      id: item.provider.id,
    };
  }
  return {
    v: 1,
    sort: "responseTime",
    responseTimeSeconds: Number.isFinite(item._response) ? item._response : null,
    id: item.provider.id,
  };
}

function compareTupleDesc(a: Array<number>, b: Array<number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

function compareTupleAsc(a: Array<number>, b: Array<number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function isAfterCursor(sort: SortMode, item: SearchItem, cursor: CursorV1): boolean {
  // Tie-breaker is always providerId DESC.
  const id = item.provider.id;

  if (sort === "relevance" && cursor.sort === "relevance") {
    if (item._score < cursor.score) return true;
    if (item._score > cursor.score) return false;
    return id < cursor.id;
  }

  if (sort === "rating" && cursor.sort === "rating") {
    const tupleItem = [item._avgRating, item._ratingCount];
    const tupleCursor = [cursor.rating, cursor.ratingCount];
    const cmp = compareTupleDesc(tupleItem, tupleCursor);
    // For DESC ordering, an item is "after" the cursor if its tuple is strictly smaller.
    if (cmp > 0) return true;
    if (cmp < 0) return false;
    return id < cursor.id;
  }

  if (sort === "distance" && cursor.sort === "distance") {
    const itemDist = item._distance;
    const cursorDist = cursor.distanceMiles == null ? Number.POSITIVE_INFINITY : cursor.distanceMiles;

    if (itemDist > cursorDist) return true;
    if (itemDist < cursorDist) return false;
    return id < cursor.id;
  }

  if (sort === "responseTime" && cursor.sort === "responseTime") {
    const itemResp = item._response;
    const cursorResp = cursor.responseTimeSeconds == null ? Number.POSITIVE_INFINITY : cursor.responseTimeSeconds;

    if (itemResp > cursorResp) return true;
    if (itemResp < cursorResp) return false;
    return id < cursor.id;
  }

  return true;
}

function buildCacheKey(input: {
  zip5: string;
  radiusMiles: number;
  categories: string[];
  minRating?: number;
  minCompletedJobs?: number;
  verifiedOnly: boolean;
  sort: SortMode;
  isAdmin: boolean;
}): string {
  const normalized = {
    zip5: input.zip5,
    radiusMiles: input.radiusMiles,
    categories: [...input.categories].sort(),
    minRating: input.minRating ?? null,
    minCompletedJobs: input.minCompletedJobs ?? null,
    verifiedOnly: input.verifiedOnly,
    sort: input.sort,
    isAdmin: input.isAdmin,
  };

  const json = JSON.stringify(normalized);
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  return `providers:search:v1:${hash}`;
}

async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    if (!getSharedRedisUrlOrNull()) return null;
    const redis = await ensureSharedRedisConnected();
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function cacheSetJson(key: string, value: unknown, ttlMs: number): Promise<void> {
  try {
    if (!getSharedRedisUrlOrNull()) return;
    const redis = await ensureSharedRedisConnected();
    await redis.set(key, JSON.stringify(value), { PX: ttlMs });
  } catch {
    // fail-open
  }
}

export function createGetProvidersSearchHandler(deps: {
  prisma: PrismaClientLike;
}): RequestHandler {
  const { prisma } = deps;

  return async (req: any, res) => {
    try {
      const authed = req as AuthedRequest;
      if (!authed.user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = providersSearchQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const {
        zip,
        radiusMiles,
        categories,
        minRating,
        minCompletedJobs,
        verifiedOnly,
        sort,
        cursor,
        limit,
      } = parsed.data;

      const zip5 = normalizeZipForBoost({ zip });
      if (!zip5) {
        return res.status(400).json({ error: "Invalid zip", details: { zip: ["zip must contain a 5-digit US ZIP"] } });
      }

      const isAdmin = authed.user.role === "ADMIN";
      const cacheKey = buildCacheKey({
        zip5,
        radiusMiles,
        categories,
        minRating,
        minCompletedJobs,
        verifiedOnly,
        sort,
        isAdmin,
      });

      type CachedPayload = {
        items: Array<Omit<SearchItem, "provider"> & { provider: ProviderCard }>;
        cachedAt: string;
      };

      // Cache whole ranked list (without favorites), short TTL.
      const cached = await cacheGetJson<CachedPayload>(cacheKey);

      let rankedAll: SearchItem[];

      if (cached?.items?.length) {
        rankedAll = cached.items as SearchItem[];
      } else {
        const where: any = {
          provider: {
            role: "PROVIDER",
            ...(isAdmin ? {} : { isSuspended: false }),
          },
        };

        if (categories.length > 0) {
          where.categories = {
            some: {
              slug: { in: categories },
            },
          };
        }

        if (verifiedOnly) {
          where.provider.providerVerification = { is: { status: "VERIFIED" } };
        }

        if (typeof minRating === "number" && Number.isFinite(minRating) && minRating > 0) {
          where.OR = [
            { provider: { providerStats: { is: { avgRating: { gte: minRating } } } } },
            { rating: { gte: minRating } },
          ];
        }

        if (typeof minCompletedJobs === "number" && Number.isFinite(minCompletedJobs) && minCompletedJobs > 0) {
          where.provider.providerStats = {
            is: {
              jobsCompletedAllTime: { gte: minCompletedJobs },
            },
          };
        }

        const maxCandidates = Math.min(Math.max(limit * 50, 250), 1000);

        const profiles = await prisma.providerProfile.findMany({
          where,
          take: maxCandidates,
          // Approximate pre-sort to keep window useful.
          orderBy: [{ rating: "desc" }, { reviewCount: "desc" }, { providerId: "desc" }],
          select: {
            experience: true,
            specialties: true,
            rating: true,
            reviewCount: true,
            verificationBadge: true,
            featuredZipCodes: true,
            categories: { select: { id: true, name: true, slug: true } },
            provider: {
              select: {
                id: true,
                name: true,
                location: true,
                subscription: { select: { tier: true } },
                providerStats: {
                  select: {
                    avgRating: true,
                    ratingCount: true,
                    jobsCompletedAllTime: true,
                    jobsCompleted30d: true,
                    medianResponseTimeSeconds30d: true,
                  },
                },
                providerEntitlement: {
                  select: {
                    verificationBadge: true,
                    featuredZipCodes: true,
                  },
                },
                providerVerification: { select: { status: true } },
              },
            },
          },
        });

        const viewerZip = zip5;

        rankedAll = profiles
          .map((p) => {
            const entitlement = p.provider.providerEntitlement;
            const verificationBadge = Boolean(entitlement?.verificationBadge ?? p.verificationBadge);

            const featuredZipCodes = entitlement?.featuredZipCodes ?? p.featuredZipCodes ?? [];
            const isFeaturedForZip = viewerZip ? featuredZipCodes.includes(viewerZip) : false;

            const subscriptionTier = p.provider.subscription?.tier ?? "FREE";

            const stats = p.provider.providerStats;
            const avgRating = stats?.avgRating ?? p.rating ?? null;
            const ratingCount = stats?.ratingCount ?? p.reviewCount ?? 0;

            const providerZip = extractZip5(p.provider.location ?? null);
            const distanceMiles =
              viewerZip && providerZip
                ? viewerZip === providerZip
                  ? 0
                  : (zipcodes.distance(viewerZip, providerZip) as number | null)
                : null;

            const ranking = rankProvider({
              distanceMiles,
              avgRating,
              ratingCount,
              medianResponseTimeSeconds30d: stats?.medianResponseTimeSeconds30d ?? null,
              subscriptionTier,
              isFeaturedForZip,
              verificationBadge,
            });

            const responseTimeSeconds = stats?.medianResponseTimeSeconds30d ?? null;

            const item: SearchItem = {
              provider: {
                id: p.provider.id,
                name: p.provider.name ?? null,
                location: p.provider.location ?? null,
                experience: p.experience ?? null,
                specialties: p.specialties ?? null,
                rating: avgRating,
                reviewCount: ratingCount,
                verificationStatus: (p.provider.providerVerification?.status ?? "NONE") as any,
                isVerified: p.provider.providerVerification?.status === "VERIFIED",
                categories: p.categories,
                stats: stats
                  ? {
                      avgRating: stats.avgRating ?? null,
                      ratingCount: stats.ratingCount ?? 0,
                      jobsCompletedAllTime: stats.jobsCompletedAllTime ?? 0,
                      jobsCompleted30d: stats.jobsCompleted30d ?? 0,
                      medianResponseTimeSeconds30d: stats.medianResponseTimeSeconds30d ?? null,
                    }
                  : null,
              },
              distanceMiles,
              scoreBreakdown: ranking,
              _score: ranking.finalScore,
              _avgRating: Number(avgRating ?? 0),
              _ratingCount: Number(ratingCount ?? 0),
              _distance: typeof distanceMiles === "number" && Number.isFinite(distanceMiles) ? distanceMiles : Number.POSITIVE_INFINITY,
              _response:
                typeof responseTimeSeconds === "number" && Number.isFinite(responseTimeSeconds)
                  ? responseTimeSeconds
                  : Number.POSITIVE_INFINITY,
            };

            return item;
          })
          .filter((it) => {
            // Radius filter: require computable distance.
            if (radiusMiles > 0) {
              if (!Number.isFinite(it._distance)) return false;
              if (it._distance > radiusMiles) return false;
            }
            return true;
          });

        // Sort
        rankedAll.sort((a, b) => {
          if (sort === "distance") {
            const cmp = compareTupleAsc([a._distance], [b._distance]);
            if (cmp !== 0) return cmp;
            return b.provider.id - a.provider.id;
          }

          if (sort === "responseTime") {
            const cmp = compareTupleAsc([a._response], [b._response]);
            if (cmp !== 0) return cmp;
            return b.provider.id - a.provider.id;
          }

          if (sort === "rating") {
            const cmp = compareTupleDesc([a._avgRating, a._ratingCount], [b._avgRating, b._ratingCount]);
            if (cmp !== 0) return cmp;
            return b.provider.id - a.provider.id;
          }

          // relevance
          if (b._score !== a._score) return b._score - a._score;
          const ratingCmp = compareTupleDesc([a._avgRating, a._ratingCount], [b._avgRating, b._ratingCount]);
          if (ratingCmp !== 0) return ratingCmp;
          return b.provider.id - a.provider.id;
        });

        await cacheSetJson(
          cacheKey,
          {
            items: rankedAll,
            cachedAt: new Date().toISOString(),
          } satisfies CachedPayload,
          30_000
        );
      }

      const parsedCursor = safeParseCursor(sort, cursor);
      const afterCursor = parsedCursor
        ? rankedAll.filter((it) => isAfterCursor(sort, it, parsedCursor))
        : rankedAll;

      const pageItems = afterCursor.slice(0, limit);
      const nextCursor = pageItems.length === limit ? base64UrlEncode(JSON.stringify(makeCursor(sort, pageItems[pageItems.length - 1]))) : null;

      // Favorites for consumers
      let favoriteIds = new Set<number>();
      if (authed.user.role === "CONSUMER" && prisma.favoriteProvider && pageItems.length > 0) {
        const providerIds = pageItems.map((it) => it.provider.id);
        const favorites = await prisma.favoriteProvider.findMany({
          where: { consumerId: authed.user.userId, providerId: { in: providerIds } },
          select: { providerId: true },
        });
        favoriteIds = new Set(favorites.map((f) => f.providerId));
      }

      return res.json({
        items: pageItems.map((it) => ({
          ...it.provider,
          isFavorited: authed.user?.role === "CONSUMER" ? favoriteIds.has(it.provider.id) : false,
          distanceMiles: it.distanceMiles,
          scoreBreakdown: {
            baseScore: it.scoreBreakdown.baseScore,
            distanceScore: it.scoreBreakdown.distanceScore,
            ratingScore: it.scoreBreakdown.ratingScore,
            responseScore: it.scoreBreakdown.responseScore,
            tierBoost: it.scoreBreakdown.tierBoost,
            featuredBoost: it.scoreBreakdown.featuredBoost,
            verifiedBoost: it.scoreBreakdown.verifiedBoost,
            finalScore: it.scoreBreakdown.finalScore,
          },
        })),
        pageInfo: {
          limit,
          nextCursor,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("GET /providers/search error:", err);
      return res.status(500).json({ error: "Internal server error while searching providers." });
    }
  };
}
