import crypto from "node:crypto";
import { prisma } from "../prisma";

export type SubscriptionTierLike = "FREE" | "BASIC" | "PRO" | string;

export type AiTaskType =
  | "classify.job"
  | "rewrite.message"
  | "summarize.thread"
  | "draft.bid"
  | "extract.fields"
  | "other";

export type AiModel = "cheap" | "premium";

export class AiQuotaExceededError extends Error {
  public readonly code = "AI_QUOTA_EXCEEDED";
  public readonly limit: number;
  public readonly used: number;
  public readonly requested: number;

  constructor(args: { limit: number; used: number; requested: number }) {
    super("AI monthly quota exceeded");
    this.limit = args.limit;
    this.used = args.used;
    this.requested = args.requested;
  }
}

function monthKeyUtc(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeInputForCache(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function getTierDefaultMonthlyLimit(tier: SubscriptionTierLike | null | undefined): number {
  const t = String(tier ?? "FREE").toUpperCase();

  const envOverride = (name: string) => {
    const raw = process.env[name];
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.floor(n));
  };

  if (t === "PRO") return envOverride("AI_TOKENS_LIMIT_PRO") ?? 250_000;
  if (t === "BASIC") return envOverride("AI_TOKENS_LIMIT_BASIC") ?? 75_000;
  return envOverride("AI_TOKENS_LIMIT_FREE") ?? 0;
}

function getCacheTtlMs(): number {
  const days = Number(process.env.AI_CACHE_TTL_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

export type AiProvider = {
  generateText: (args: {
    model: string;
    system?: string;
    prompt: string;
    maxOutputTokens?: number;
  }) => Promise<{ text: string; usedTokens?: number }>;
};

export type AiQuotaState = {
  aiMonthlyTokenLimit: number | null;
  aiTokensUsedThisMonth: number;
  aiUsageMonthKey: string | null;
  tier: SubscriptionTierLike;
};

export type AiQuotaAdapter = {
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  getUserAiState: (userId: number) => Promise<AiQuotaState | null>;
  updateUserAiState: (
    userId: number,
    patch: { aiMonthlyTokenLimit?: number | null; aiTokensUsedThisMonth?: number; aiUsageMonthKey?: string | null }
  ) => Promise<void>;
};

export type AiCacheEntryLike = {
  text: string;
  model: AiModel;
  expiresAt: Date | null;
};

export type AiCacheAdapter = {
  get: (key: string) => Promise<AiCacheEntryLike | null>;
  set: (key: string, entry: { taskType: AiTaskType; normalizedInput: string; model: AiModel; text: string; expiresAt: Date | null }) => Promise<void>;
};

export function createAiGateway(deps: {
  quota: AiQuotaAdapter;
  cache: AiCacheAdapter;
  provider: AiProvider;
}) {
  const consume = async (userId: number, estimatedTokens: number): Promise<void> => {
    const uid = Number(userId);
    const req = Math.max(0, Math.floor(Number(estimatedTokens ?? 0)));
    if (!Number.isFinite(uid) || uid <= 0) throw new Error("consumeAiTokens: invalid userId");
    if (!Number.isFinite(req) || req < 0) throw new Error("consumeAiTokens: invalid estimatedTokens");

    const nowKey = monthKeyUtc();

    await deps.quota.transaction(async () => {
      const user = await deps.quota.getUserAiState(uid);
      if (!user) throw new Error("User not found");

      const sameMonth = (user.aiUsageMonthKey ?? null) === nowKey;
      const used = sameMonth ? Number(user.aiTokensUsedThisMonth ?? 0) : 0;

      if (!sameMonth) {
        await deps.quota.updateUserAiState(uid, {
          aiTokensUsedThisMonth: 0,
          aiUsageMonthKey: nowKey,
        });
      }

      const limit =
        typeof user.aiMonthlyTokenLimit === "number"
          ? Math.max(0, Math.floor(user.aiMonthlyTokenLimit))
          : getTierDefaultMonthlyLimit(user.tier);

      if (req === 0) return;

      if (used + req > limit) {
        throw new AiQuotaExceededError({ limit, used, requested: req });
      }

      await deps.quota.updateUserAiState(uid, {
        aiTokensUsedThisMonth: used + req,
        aiUsageMonthKey: nowKey,
      });
    });
  };

  const run = async (
    args: RunAiTaskArgs
  ): Promise<{ text: string; cached: boolean; model: AiModel }> => {
    const taskType = args.taskType ?? "other";
    const normalizedInput = normalizeInputForCache(args.input);
    const key = sha256Hex(`${taskType}\n${normalizedInput}`);

    const cached = await deps.cache.get(key);
    if (cached && (!cached.expiresAt || cached.expiresAt.getTime() > Date.now())) {
      return { text: cached.text, cached: true, model: cached.model };
    }

    // Enforce quota BEFORE any provider call
    await consume(args.userId, args.estimatedTokens);

    const state = await deps.quota.getUserAiState(args.userId);
    const tier = state?.tier ?? "FREE";
    const modelSel = selectModel({ tier, taskType });

    const out = await deps.provider.generateText({
      model: modelSel.sdkModel,
      system: args.system,
      prompt: args.input,
      maxOutputTokens: args.maxOutputTokens,
    });

    const ttlMs = getCacheTtlMs();
    const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs) : null;
    await deps.cache.set(key, {
      taskType,
      normalizedInput,
      model: modelSel.label,
      text: out.text,
      expiresAt,
    });

    return { text: out.text, cached: false, model: modelSel.label };
  };

  return {
    consumeAiTokens: consume,
    runAiTask: run,
  };
}

export type RunAiTaskArgs = {
  userId: number;
  taskType: AiTaskType;
  input: string;
  system?: string;
  estimatedTokens: number;
  maxOutputTokens?: number;
};

function selectModel(args: { tier: SubscriptionTierLike; taskType: AiTaskType }): { label: AiModel; sdkModel: string } {
  const tier = String(args.tier ?? "FREE").toUpperCase();

  const premiumAllowlist: AiTaskType[] = ["draft.bid"];
  const wantsPremium = premiumAllowlist.includes(args.taskType);

  if (tier === "PRO" && wantsPremium) {
    return {
      label: "premium",
      sdkModel: process.env.AI_MODEL_PREMIUM ?? "gpt-4o",
    };
  }

  // Default: cheap model for repetitive + everything else.
  return {
    label: "cheap",
    sdkModel: process.env.AI_MODEL_CHEAP ?? "gpt-4o-mini",
  };
}

/**
 * Enforces monthly quota for a given user.
 * - Cache hits should not call this.
 * - Includes a lazy month rollover in case the monthly reset job hasn't run yet.
 */
export async function consumeAiTokens(userId: number, estimatedTokens: number): Promise<void> {
  return defaultAiGateway.consumeAiTokens(userId, estimatedTokens);
}

export async function runAiTask(
  args: RunAiTaskArgs,
  provider: AiProvider
): Promise<{ text: string; cached: boolean; model: AiModel }> {
  const gateway = createAiGateway({ quota: prismaQuotaAdapter, cache: prismaCacheAdapter, provider });
  return gateway.runAiTask(args);
}

export function estimateTokensRough(text: string): number {
  // Very rough heuristic: ~4 chars/token, plus a small constant.
  const s = String(text ?? "");
  return Math.max(1, Math.ceil(s.length / 4) + 20);
}

export function getCurrentMonthKeyUtc(): string {
  return monthKeyUtc();
}

export async function resetAiUsageForNewMonth(now = new Date()): Promise<{ monthKey: string; resetCount: number }> {
  const mk = monthKeyUtc(now);
  const res = await prisma.user
    .updateMany({
      where: {
        OR: [{ aiUsageMonthKey: null }, { aiUsageMonthKey: { not: mk } }],
      },
      data: {
        aiTokensUsedThisMonth: 0,
        aiUsageMonthKey: mk,
      },
    })
    .catch((e) => {
      const msg = String((e as any)?.message ?? e);
      if (/column/i.test(msg) && /does not exist/i.test(msg)) {
        return { count: 0 } as any;
      }
      throw e;
    });

  return { monthKey: mk, resetCount: res.count ?? 0 };
}

const prismaQuotaAdapter: AiQuotaAdapter = {
  transaction: (fn) => prisma.$transaction(fn),
  getUserAiState: async (userId) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        aiMonthlyTokenLimit: true,
        aiTokensUsedThisMonth: true,
        aiUsageMonthKey: true,
        subscription: { select: { tier: true } },
      },
    });
    if (!user) return null;
    return {
      aiMonthlyTokenLimit: typeof user.aiMonthlyTokenLimit === "number" ? user.aiMonthlyTokenLimit : null,
      aiTokensUsedThisMonth: Number(user.aiTokensUsedThisMonth ?? 0),
      aiUsageMonthKey: (user as any).aiUsageMonthKey ?? null,
      tier: user.subscription?.tier ?? "FREE",
    };
  },
  updateUserAiState: async (userId, patch) => {
    await prisma.user.update({
      where: { id: userId },
      data: patch,
    });
  },
};

const prismaCacheAdapter: AiCacheAdapter = {
  get: async (key) => {
    const row = await prisma.aiCacheEntry.findUnique({
      where: { key },
      select: { response: true, model: true, expiresAt: true },
    });
    if (!row) return null;
    const text = (row.response as any)?.text;
    if (typeof text !== "string") return null;
    return {
      text,
      model: row.model === "premium" ? "premium" : "cheap",
      expiresAt: row.expiresAt ?? null,
    };
  },
  set: async (key, entry) => {
    const now = new Date();
    await prisma.aiCacheEntry.upsert({
      where: { key },
      create: {
        key,
        taskType: entry.taskType,
        normalizedInput: entry.normalizedInput,
        response: { text: entry.text },
        model: entry.model,
        createdAt: now,
        expiresAt: entry.expiresAt,
      },
      update: {
        response: { text: entry.text },
        model: entry.model,
        createdAt: now,
        expiresAt: entry.expiresAt,
      },
    });
  },
};

const defaultAiGateway = createAiGateway({
  quota: prismaQuotaAdapter,
  cache: prismaCacheAdapter,
  provider: {
    generateText: async () => {
      throw new Error("AI provider not configured. Use runAiTask(args, provider). ");
    },
  },
});

export function createInMemoryAiGatewayForTest(params: {
  users: Map<number, AiQuotaState>;
  cache?: Map<string, AiCacheEntryLike>;
  provider: AiProvider;
}) {
  const cacheMap = params.cache ?? new Map<string, AiCacheEntryLike>();

  const quota: AiQuotaAdapter = {
    transaction: async (fn) => fn(),
    getUserAiState: async (userId) => params.users.get(userId) ?? null,
    updateUserAiState: async (userId, patch) => {
      const cur = params.users.get(userId);
      if (!cur) return;
      params.users.set(userId, {
        ...cur,
        ...patch,
        aiTokensUsedThisMonth:
          typeof patch.aiTokensUsedThisMonth === "number" ? patch.aiTokensUsedThisMonth : cur.aiTokensUsedThisMonth,
        aiUsageMonthKey:
          typeof patch.aiUsageMonthKey === "undefined" ? cur.aiUsageMonthKey : (patch.aiUsageMonthKey ?? null),
        aiMonthlyTokenLimit:
          typeof patch.aiMonthlyTokenLimit === "undefined" ? cur.aiMonthlyTokenLimit : (patch.aiMonthlyTokenLimit ?? null),
      });
    },
  };

  const cache: AiCacheAdapter = {
    get: async (key) => cacheMap.get(key) ?? null,
    set: async (key, entry) => {
      cacheMap.set(key, {
        text: entry.text,
        model: entry.model,
        expiresAt: entry.expiresAt,
      });
    },
  };

  return createAiGateway({ quota, cache, provider: params.provider });
}
