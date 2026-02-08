import { prisma } from "../prisma";

export type RiskSignal = {
  code:
    | "BANNED_KEYWORD"
    | "CONTACT_INFO"
    | "TOO_MANY_JOBS"
    | "REPEATED_MESSAGE"
    | "REPEATED_BID_MESSAGE";
  score: number;
  detail?: string;
};

export type RiskAssessment = {
  totalScore: number;
  signals: RiskSignal[];
};

export const RISK_REVIEW_THRESHOLD = 60;
export const RISK_RESTRICT_THRESHOLD = 100;
export const RESTRICTION_HOURS_DEFAULT = 24;

const BANNED_KEYWORDS: Array<{ phrase: string; score: number }> = [
  { phrase: "western union", score: 50 },
  { phrase: "moneygram", score: 50 },
  { phrase: "gift card", score: 40 },
  { phrase: "steam card", score: 40 },
  { phrase: "wire transfer", score: 45 },
  { phrase: "bank transfer", score: 45 },
  { phrase: "crypto", score: 35 },
  { phrase: "bitcoin", score: 35 },
  { phrase: "zelle", score: 25 },
  { phrase: "telegram", score: 25 },
  { phrase: "whatsapp", score: 20 },
  { phrase: "whats app", score: 20 },
  { phrase: "cashapp", score: 20 },
  { phrase: "cash app", score: 20 },
  { phrase: "venmo", score: 20 },
  { phrase: "venmo me", score: 20 },
  { phrase: "paypal", score: 20 },
];

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
// US-centric, but catches most spam attempts. Avoids matching short numeric ranges.
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/;

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function assessTextRisk(text: string): RiskAssessment {
  const t = normalize(text);
  const signals: RiskSignal[] = [];

  for (const kw of BANNED_KEYWORDS) {
    if (t.includes(kw.phrase)) {
      signals.push({ code: "BANNED_KEYWORD", score: kw.score, detail: kw.phrase });
    }
  }

  const hasEmail = EMAIL_RE.test(text);
  const hasPhone = PHONE_RE.test(text);
  if (hasEmail || hasPhone) {
    const detail = [hasEmail ? "email" : null, hasPhone ? "phone" : null].filter(Boolean).join(",");
    signals.push({ code: "CONTACT_INFO", score: hasEmail && hasPhone ? 55 : 35, detail });
  }

  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);
  return { totalScore, signals };
}

// Alias used by message anti-scam controls.
export function scanMessageRisk(text: string): RiskAssessment {
  return assessTextRisk(text);
}

export type MessageModerationDecision =
  | { action: "ALLOW" }
  | {
      action: "BLOCK";
      reasonCodes: Array<"CONTACT_INFO" | "BANNED_KEYWORD">;
    };

/**
 * Pure decision helper for message anti-scam enforcement.
 * Note: intentionally does NOT block on repeated-message signals alone.
 */
export function decideMessageModeration(risk: RiskAssessment): MessageModerationDecision {
  const reasonCodes: Array<"CONTACT_INFO" | "BANNED_KEYWORD"> = [];

  if (risk.signals.some((s) => s.code === "CONTACT_INFO")) {
    reasonCodes.push("CONTACT_INFO");
  }

  if (risk.signals.some((s) => s.code === "BANNED_KEYWORD")) {
    reasonCodes.push("BANNED_KEYWORD");
  }

  if (reasonCodes.length) return { action: "BLOCK", reasonCodes };
  return { action: "ALLOW" };
}

export async function assessJobPostRisk(params: {
  consumerId: number;
  title: string;
  description: string;
  location?: string | null;
}): Promise<RiskAssessment> {
  const base = assessTextRisk(`${params.title}\n${params.description}\n${params.location ?? ""}`);

  const windowMinutes = 30;
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const recentCount = await prisma.job.count({
    where: { consumerId: params.consumerId, createdAt: { gt: since } },
  });

  const signals = [...base.signals];
  if (recentCount >= 3) {
    const extra = recentCount - 2;
    signals.push({
      code: "TOO_MANY_JOBS",
      score: 15 * extra,
      detail: `${recentCount} jobs in ${windowMinutes}m`,
    });
  }

  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);
  return { totalScore, signals };
}

export async function assessRepeatedMessageRisk(params: {
  jobId: number;
  senderId: number;
  text: string;
}): Promise<RiskAssessment> {
  const base = assessTextRisk(params.text);

  const windowMinutes = 10;
  const since = new Date(Date.now() - windowMinutes * 60_000);

  const normalized = normalize(params.text);

  const sameCount = await prisma.message.count({
    where: {
      jobId: params.jobId,
      senderId: params.senderId,
      createdAt: { gt: since },
      text: { equals: params.text },
    },
  });

  const signals = [...base.signals];
  if (sameCount >= 2 && normalized.length >= 20) {
    signals.push({
      code: "REPEATED_MESSAGE",
      score: 25 + (sameCount - 2) * 10,
      detail: `${sameCount + 1} repeats in ${windowMinutes}m`,
    });
  }

  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);
  return { totalScore, signals };
}

export async function assessRepeatedBidMessageRisk(params: {
  jobId: number;
  providerId: number;
  messageText: string;
}): Promise<RiskAssessment> {
  const base = assessTextRisk(params.messageText);

  const windowMinutes = 60;
  const since = new Date(Date.now() - windowMinutes * 60_000);

  const sameCount = await prisma.bid.count({
    where: {
      jobId: params.jobId,
      providerId: params.providerId,
      createdAt: { gt: since },
      message: { equals: params.messageText },
    },
  });

  const signals = [...base.signals];
  if (sameCount >= 1 && normalize(params.messageText).length >= 20) {
    signals.push({
      code: "REPEATED_BID_MESSAGE",
      score: 20 + (sameCount - 1) * 10,
      detail: `${sameCount + 1} repeats in ${windowMinutes}m`,
    });
  }

  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);
  return { totalScore, signals };
}

export function computeRestrictedUntil(hours = RESTRICTION_HOURS_DEFAULT): Date {
  return new Date(Date.now() + hours * 60 * 60_000);
}
