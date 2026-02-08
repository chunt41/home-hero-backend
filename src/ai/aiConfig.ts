export type SubscriptionTierLike = "FREE" | "BASIC" | "PRO" | string;

export const AI_TIER_DEFAULT_MONTHLY_TOKEN_LIMITS = {
  FREE: 0,
  BASIC: 2000,
  PRO: 5000,
} as const;

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

export function getAiTierDefaultMonthlyTokenLimit(tier: SubscriptionTierLike | null | undefined): number {
  const t = String(tier ?? "FREE").toUpperCase();

  if (t === "PRO") return envInt("AI_TOKENS_LIMIT_PRO") ?? AI_TIER_DEFAULT_MONTHLY_TOKEN_LIMITS.PRO;
  if (t === "BASIC") return envInt("AI_TOKENS_LIMIT_BASIC") ?? AI_TIER_DEFAULT_MONTHLY_TOKEN_LIMITS.BASIC;
  return envInt("AI_TOKENS_LIMIT_FREE") ?? AI_TIER_DEFAULT_MONTHLY_TOKEN_LIMITS.FREE;
}

/**
 * Premium models are only allowed for explicitly high-value tasks.
 * Anything not on this list should remain cheap-by-default.
 */
export const AI_PREMIUM_MODEL_ALLOWLIST_TASK_TYPES = ["draft.bid"] as const;

/**
 * When set (positive integer), emit an alert when a single user exceeds this many tokens
 * within the current UTC month.
 *
 * Recommended: set below the PRO monthly limit to proactively catch heavy users.
 */
export function getAiMonthlyUserAlertThresholdTokens(): number | null {
  const n = envInt("AI_MONTHLY_USER_ALERT_THRESHOLD_TOKENS");
  if (!n || n <= 0) return null;
  return n;
}
