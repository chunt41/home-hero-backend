import type { RiskAssessment, RiskSignal } from "./riskScoring";

const OFFPLATFORM_KEYWORDS = new Set(["telegram", "whatsapp"]);

function isBannedKeyword(signal: RiskSignal): signal is RiskSignal & { code: "BANNED_KEYWORD" } {
  return signal.code === "BANNED_KEYWORD";
}

/**
 * Classify whether a message is trying to move communication off-platform.
 *
 * - "contact" covers phone/email (CONTACT_INFO) and chat apps (telegram/whatsapp)
 * - other BANNED_KEYWORD phrases are treated as higher-risk payment scam attempts and should remain blocked
 */
export function classifyOffPlatformRisk(risk: RiskAssessment): {
  hasContactInfo: boolean;
  offPlatformKeywords: string[];
  scamKeywords: string[];
  isOnlyContactLike: boolean;
} {
  const hasContactInfo = risk.signals.some((s) => s.code === "CONTACT_INFO");

  const bannedKeywordDetails = risk.signals
    .filter(isBannedKeyword)
    .map((s) => String(s.detail ?? "").toLowerCase())
    .filter(Boolean);

  const offPlatformKeywords = bannedKeywordDetails.filter((d) => OFFPLATFORM_KEYWORDS.has(d));
  const scamKeywords = bannedKeywordDetails.filter((d) => !OFFPLATFORM_KEYWORDS.has(d));

  const isOnlyContactLike = (hasContactInfo || offPlatformKeywords.length > 0) && scamKeywords.length === 0;

  return { hasContactInfo, offPlatformKeywords, scamKeywords, isOnlyContactLike };
}

export type OffPlatformGateReason =
  | "job_status_awarded_or_later"
  | "contact_exchange_approved"
  | "sender_verified_low_risk";

/**
 * Decide whether we should bypass CONTACT_INFO/telegram/whatsapp blocking.
 *
 * Important: If the message includes scam/payment keywords (e.g. zelle, crypto), this MUST return bypass=false.
 */
export function shouldBypassOffPlatformContactBlock(params: {
  risk: RiskAssessment;
  jobStatus: string | null | undefined;
  contactExchangeApproved: boolean;
  senderVerifiedLowRisk: boolean;
}): { bypass: boolean; reason?: OffPlatformGateReason } {
  const classification = classifyOffPlatformRisk(params.risk);
  if (!classification.isOnlyContactLike) return { bypass: false };

  if (jobStatusAllowsOffPlatformContact(params.jobStatus)) {
    return { bypass: true, reason: "job_status_awarded_or_later" };
  }

  if (params.contactExchangeApproved) {
    return { bypass: true, reason: "contact_exchange_approved" };
  }

  if (params.senderVerifiedLowRisk) {
    return { bypass: true, reason: "sender_verified_low_risk" };
  }

  return { bypass: false };
}

export function computeRiskScoreExcludingContactLike(risk: RiskAssessment): number {
  const signals = risk.signals.filter((s) => {
    if (s.code === "CONTACT_INFO") return false;
    if (s.code === "BANNED_KEYWORD") {
      const d = String((s as any).detail ?? "").toLowerCase();
      if (OFFPLATFORM_KEYWORDS.has(d)) return false;
    }
    return true;
  });

  return signals.reduce((sum, s) => sum + (Number.isFinite(s.score) ? s.score : 0), 0);
}

export function jobStatusAllowsOffPlatformContact(jobStatus: string | null | undefined): boolean {
  if (!jobStatus) return false;
  // "AWARDED or later" (OPEN is the only pre-award state in this system).
  return jobStatus !== "OPEN";
}
