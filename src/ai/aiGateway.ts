import crypto from "node:crypto";
import { prisma } from "../prisma";
import { captureMessage } from "../observability/sentry";
import {
  AI_PREMIUM_MODEL_ALLOWLIST_TASK_TYPES,
  getAiMonthlyUserAlertThresholdTokens,
  getAiTierDefaultMonthlyTokenLimit,
} from "./aiConfig";

export type SubscriptionTierLike = "FREE" | "BASIC" | "PRO" | string;

export type AiTaskType =
  | "classify.job"
  | "rewrite.message"
  | "summarize.thread"
  | "draft.bid"
  | "extract.fields"
  | "other";

export type AiModel = "cheap" | "premium";

export type AiTelemetryEventType = "ai.cache_hit" | "ai.provider_call" | "ai.blocked_quota";

export type AiTelemetryAdapter = {
  recordEvent: (event: {
    type: AiTelemetryEventType;
    userId: number;
    monthKey: string;
    taskType: AiTaskType;
    model?: AiModel;
    tier?: SubscriptionTierLike;
    estimatedTokens?: number;
    usedTokens?: number;
    errorCode?: string;
  }) => Promise<void>;
};

export type AiAlertsAdapter = {
  alertUserMonthlyThresholdExceeded: (args: {
    userId: number;
    monthKey: string;
    tier: SubscriptionTierLike;
    thresholdTokens: number;
    usedBefore: number;
    usedAfter: number;
  }) => Promise<void>;
};

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
  telemetry?: AiTelemetryAdapter;
  alerts?: AiAlertsAdapter;
}) {
  const consume = async (userId: number, estimatedTokens: number): Promise<void> => {
    const uid = Number(userId);
    const req = Math.max(0, Math.floor(Number(estimatedTokens ?? 0)));
    if (!Number.isFinite(uid) || uid <= 0) throw new Error("consumeAiTokens: invalid userId");
    if (!Number.isFinite(req) || req < 0) throw new Error("consumeAiTokens: invalid estimatedTokens");

    const nowKey = monthKeyUtc();

    let usedBefore = 0;
    let usedAfter = 0;
    let tier: SubscriptionTierLike = "FREE";

    await deps.quota.transaction(async () => {
      const user = await deps.quota.getUserAiState(uid);
      if (!user) throw new Error("User not found");

      tier = user.tier ?? "FREE";

      const sameMonth = (user.aiUsageMonthKey ?? null) === nowKey;
      const used = sameMonth ? Number(user.aiTokensUsedThisMonth ?? 0) : 0;
      usedBefore = used;

      if (!sameMonth) {
        await deps.quota.updateUserAiState(uid, {
          aiTokensUsedThisMonth: 0,
          aiUsageMonthKey: nowKey,
        });
      }

      const limit =
        typeof user.aiMonthlyTokenLimit === "number"
          ? Math.max(0, Math.floor(user.aiMonthlyTokenLimit))
          : getAiTierDefaultMonthlyTokenLimit(user.tier);

      if (req === 0) return;

      if (used + req > limit) {
        throw new AiQuotaExceededError({ limit, used, requested: req });
      }

      usedAfter = used + req;

      await deps.quota.updateUserAiState(uid, {
        aiTokensUsedThisMonth: used + req,
        aiUsageMonthKey: nowKey,
      });
    });

    const threshold = getAiMonthlyUserAlertThresholdTokens();
    if (deps.alerts && threshold && threshold > 0) {
      void deps.alerts.alertUserMonthlyThresholdExceeded({
        userId: uid,
        monthKey: nowKey,
        tier,
        thresholdTokens: threshold,
        usedBefore,
        usedAfter,
      });
    }
  };

  const run = async (
    args: RunAiTaskArgs
  ): Promise<{ text: string; cached: boolean; model: AiModel }> => {
    const taskType = args.taskType ?? "other";
    const normalizedInput = normalizeInputForCache(args.input);
    const key = sha256Hex(`${taskType}\n${normalizedInput}`);
    const nowKey = monthKeyUtc();

    const cached = await deps.cache.get(key);
    if (cached && (!cached.expiresAt || cached.expiresAt.getTime() > Date.now())) {
      if (deps.telemetry) {
        void deps.telemetry.recordEvent({
          type: "ai.cache_hit",
          userId: args.userId,
          monthKey: nowKey,
          taskType,
          model: cached.model,
        });
      }
      return { text: cached.text, cached: true, model: cached.model };
    }

    // Enforce quota BEFORE any provider call
    try {
      await consume(args.userId, args.estimatedTokens);
    } catch (e: any) {
      if (deps.telemetry && e instanceof AiQuotaExceededError) {
        void deps.telemetry.recordEvent({
          type: "ai.blocked_quota",
          userId: args.userId,
          monthKey: nowKey,
          taskType,
          estimatedTokens: args.estimatedTokens,
          errorCode: e.code,
        });
      }
      throw e;
    }

    const state = await deps.quota.getUserAiState(args.userId);
    const tier = state?.tier ?? "FREE";
    const modelSel = selectModel({ tier, taskType });

    const out = await deps.provider.generateText({
      model: modelSel.sdkModel,
      system: args.system,
      prompt: args.input,
      maxOutputTokens: args.maxOutputTokens,
    });

    if (deps.telemetry) {
      void deps.telemetry.recordEvent({
        type: "ai.provider_call",
        userId: args.userId,
        monthKey: nowKey,
        taskType,
        model: modelSel.label,
        tier,
        estimatedTokens: args.estimatedTokens,
        usedTokens: typeof out.usedTokens === "number" ? out.usedTokens : undefined,
      });
    }

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

  const wantsPremium = (AI_PREMIUM_MODEL_ALLOWLIST_TASK_TYPES as readonly string[]).includes(args.taskType);

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
  const gateway = createAiGateway({
    quota: prismaQuotaAdapter,
    cache: prismaCacheAdapter,
    provider,
    telemetry: prismaTelemetryAdapter,
    alerts: prismaAlertsAdapter,
  });
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

const prismaTelemetryAdapter: AiTelemetryAdapter = {
  recordEvent: async (event) => {
    try {
      await prisma.securityEvent.create({
        data: {
          actionType: event.type,
          actorUserId: event.userId,
          targetType: "AI_TASK",
          targetId: String(event.taskType),
          metadataJson: {
            monthKey: event.monthKey,
            model: event.model,
            tier: event.tier,
            estimatedTokens: event.estimatedTokens,
            usedTokens: event.usedTokens,
            errorCode: event.errorCode,
          },
        },
      });
    } catch {
      // best-effort only
    }
  },
};

const prismaAlertsAdapter: AiAlertsAdapter = {
  alertUserMonthlyThresholdExceeded: async (args) => {
    try {
      if (!Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) return;
      if (args.usedAfter < args.thresholdTokens) return;
      if (args.usedBefore >= args.thresholdTokens) return;

      const [yStr, mStr] = String(args.monthKey).split("-");
      const y = Number(yStr);
      const m = Number(mStr);
      if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return;
      const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));

      const existing = await prisma.securityEvent
        .findFirst({
          where: {
            actionType: "ai.user_monthly_threshold_exceeded",
            actorUserId: args.userId,
            createdAt: { gte: start, lt: end },
          },
          select: { id: true },
        })
        .catch(() => null);

      if (existing?.id) return;

      await prisma.securityEvent.create({
        data: {
          actionType: "ai.user_monthly_threshold_exceeded",
          actorUserId: args.userId,
          targetType: "USER",
          targetId: String(args.userId),
          metadataJson: {
            monthKey: args.monthKey,
            tier: String(args.tier ?? "FREE"),
            thresholdTokens: args.thresholdTokens,
            usedAfter: args.usedAfter,
          },
        },
      });

      captureMessage("AI user exceeded monthly token threshold", {
        level: "warning",
        userId: args.userId,
        monthKey: args.monthKey,
        tier: String(args.tier ?? "FREE"),
        thresholdTokens: args.thresholdTokens,
        usedAfter: args.usedAfter,
      });
    } catch {
      // best-effort only
    }
  },
};

const defaultAiGateway = createAiGateway({
  quota: prismaQuotaAdapter,
  cache: prismaCacheAdapter,
  telemetry: prismaTelemetryAdapter,
  alerts: prismaAlertsAdapter,
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
