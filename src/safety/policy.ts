import { computeRestrictedUntil } from "../services/riskScoring";

export type SafetyRestrictionDecision =
  | { action: "NONE" }
  | { action: "RESTRICT"; restrictedUntil: Date; minutes: number; reason: string; metadata?: any };

export function computeEscalatingRestrictionMinutes(params: {
  violationCountIncludingThis: number;
  steps?: Array<{ atOrAbove: number; minutes: number }>;
}): number | null {
  const steps =
    params.steps ??
    [
      { atOrAbove: 3, minutes: 30 },
      { atOrAbove: 5, minutes: 6 * 60 },
      { atOrAbove: 8, minutes: 24 * 60 },
    ];

  const count = params.violationCountIncludingThis;
  let picked: number | null = null;
  for (const s of steps) {
    if (count >= s.atOrAbove) picked = s.minutes;
  }
  return picked;
}

export async function decideRestrictionFromRecentSecurityEvents(params: {
  prisma: any;
  actorUserId: number;
  actionType: string;
  windowMinutes: number;
  reason: string;
  steps?: Array<{ atOrAbove: number; minutes: number }>;
}): Promise<SafetyRestrictionDecision> {
  const since = new Date(Date.now() - params.windowMinutes * 60_000);

  let recentCount = 0;
  try {
    recentCount = await params.prisma.securityEvent.count({
      where: {
        actorUserId: params.actorUserId,
        actionType: params.actionType,
        createdAt: { gt: since },
      },
    });
  } catch {
    // If this query fails for any reason, do not block the caller.
    return { action: "NONE" };
  }

  // Count includes the just-created event in most flows, but callsites should be consistent.
  const minutes = computeEscalatingRestrictionMinutes({
    violationCountIncludingThis: recentCount,
    steps: params.steps,
  });

  if (!minutes) return { action: "NONE" };

  const restrictedUntil = computeRestrictedUntil(minutes / 60);
  return {
    action: "RESTRICT",
    restrictedUntil,
    minutes,
    reason: params.reason,
    metadata: { recentCount, windowMinutes: params.windowMinutes },
  };
}

export async function applyUserRestriction(params: {
  prisma: any;
  userId: number;
  restrictedUntil: Date;
  riskScoreIncrement?: number;
}): Promise<void> {
  try {
    await params.prisma.user.update({
      where: { id: params.userId },
      data: {
        restrictedUntil: params.restrictedUntil,
        ...(typeof params.riskScoreIncrement === "number"
          ? { riskScore: { increment: params.riskScoreIncrement } }
          : {}),
      },
    });
  } catch {
    // best-effort
  }
}

export type ShadowHideDecision =
  | { action: "NONE" }
  | { action: "HIDE"; reason: string; metadata?: any };

export function decideShadowHideFromRisk(params: {
  riskTotalScore: number;
  hideAtOrAbove?: number;
  reason: string;
  metadata?: any;
}): ShadowHideDecision {
  const threshold = params.hideAtOrAbove ?? 40;
  if (params.riskTotalScore >= threshold) {
    return { action: "HIDE", reason: params.reason, metadata: params.metadata };
  }
  return { action: "NONE" };
}
