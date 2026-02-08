import type { RiskAssessment } from "./riskScoring";
import {
  assessRepeatedMessageRisk as assessRepeatedMessageRiskProd,
  computeRestrictedUntil,
  decideMessageModeration,
  RISK_RESTRICT_THRESHOLD,
} from "./riskScoring";
import {
  classifyOffPlatformRisk,
  computeRiskScoreExcludingOffPlatformVectors,
  shouldBypassOffPlatformContactBlock,
} from "./contactExchangeGate";

function isMissingDbColumnError(err: any): boolean {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  if (code === "P2022") return true;
  return /column/i.test(msg) && /does not exist/i.test(msg);
}

export type AssessRepeatedMessageRisk = (params: {
  jobId: number;
  senderId: number;
  text: string;
}) => Promise<RiskAssessment>;

export type JobMessageSendModerationResult =
  | { action: "ALLOW" }
  | {
      action: "BLOCK";
      status: 400;
      body: {
        error: string;
        code: "CONTACT_INFO_NOT_ALLOWED" | "MESSAGE_BLOCKED";
        blocked: true;
        reasonCodes: Array<"CONTACT_INFO" | "BANNED_KEYWORD">;
        appealUrl: string;
      };
    }
  | {
      action: "RESTRICTED";
      status: 403;
      restrictedUntil: Date;
      message: string;
    };

export async function moderateJobMessageSend(params: {
  prisma: any;
  req: any;
  isAdmin: boolean;
  jobId: number;
  jobStatus: string | null | undefined;
  senderId: number;
  messageText: string;
  appealUrl: string;
  logSecurityEvent: (req: any, actionType: string, payload: any) => Promise<void>;
  assessRepeatedMessageRisk?: AssessRepeatedMessageRisk;
}): Promise<JobMessageSendModerationResult> {
  if (params.isAdmin) return { action: "ALLOW" };

  const assessRepeatedMessageRisk =
    params.assessRepeatedMessageRisk ?? (assessRepeatedMessageRiskProd as AssessRepeatedMessageRisk);

  const risk = await assessRepeatedMessageRisk({
    jobId: params.jobId,
    senderId: params.senderId,
    text: params.messageText,
  });

  let riskScoreToApply = risk.totalScore;

  const moderation = decideMessageModeration(risk);
  if (moderation.action === "BLOCK") {
    const offPlatform = classifyOffPlatformRisk(risk);

    let contactExchangeApproved = false;
    try {
      const approved = await params.prisma.contactExchangeRequest.findFirst({
        where: { jobId: params.jobId, status: "APPROVED" },
        select: { id: true },
      });
      contactExchangeApproved = !!approved;
    } catch {
      contactExchangeApproved = false;
    }

    const gate = shouldBypassOffPlatformContactBlock({
      risk,
      jobStatus: params.jobStatus,
      contactExchangeApproved,
    });

    if (gate.bypass) {
      // If the job is awarded or contact exchange is approved, allow sharing details.
      // Keep defense-in-depth by still logging and only applying non-offplatform risk scoring.
      riskScoreToApply = computeRiskScoreExcludingOffPlatformVectors(risk);

      await params.logSecurityEvent(params.req, "message.offplatform_allowed", {
        targetType: "JOB",
        targetId: params.jobId,
        jobId: params.jobId,
        senderId: params.senderId,
        gateReason: gate.reason,
        jobStatus: params.jobStatus,
        contactExchangeApproved,
        offPlatform: {
          hasContactInfo: offPlatform.hasContactInfo,
          chatAppKeywords: offPlatform.offPlatformKeywords,
          paymentKeywords: offPlatform.scamKeywords,
        },
        riskTotalScore: risk.totalScore,
        riskSignals: risk.signals,
        appliedRiskScore: riskScoreToApply,
        textPreview: params.messageText.slice(0, 200),
      });

      if (riskScoreToApply >= RISK_RESTRICT_THRESHOLD) {
        const until = computeRestrictedUntil();
        try {
          await params.prisma.user.update({
            where: { id: params.senderId },
            data: { riskScore: { increment: riskScoreToApply }, restrictedUntil: until },
          });
        } catch (e: any) {
          if (!isMissingDbColumnError(e)) throw e;
        }

        await params.logSecurityEvent(params.req, "user.restricted", {
          targetType: "USER",
          targetId: params.senderId,
          reason: "message_risk_threshold",
          jobId: params.jobId,
          riskTotalScore: riskScoreToApply,
          riskSignals: risk.signals,
          restrictedUntil: until.toISOString(),
        });

        return {
          action: "RESTRICTED",
          status: 403,
          restrictedUntil: until,
          message: "Your account is temporarily restricted due to suspicious activity.",
        };
      }

      if (riskScoreToApply > 0) {
        try {
          await params.prisma.user.update({
            where: { id: params.senderId },
            data: { riskScore: { increment: riskScoreToApply } },
          });
        } catch (e: any) {
          if (!isMissingDbColumnError(e)) throw e;
        }
      }

      return { action: "ALLOW" };
    }

    // If we got here, we are blocking (either scam-like keywords OR gate rejected).
    try {
      await params.prisma.user.update({
        where: { id: params.senderId },
        data: { riskScore: { increment: risk.totalScore } },
      });
    } catch (e: any) {
      if (!isMissingDbColumnError(e)) throw e;
    }

    await params.logSecurityEvent(params.req, "message.blocked", {
      targetType: "JOB",
      targetId: params.jobId,
      jobId: params.jobId,
      senderId: params.senderId,
      reasonCodes: moderation.reasonCodes,
      riskTotalScore: risk.totalScore,
      riskSignals: risk.signals,
      textPreview: params.messageText.slice(0, 200),
    });

    try {
      // Repeat offender logic:
      // after 3 blocked attempts in 10 minutes → restrict messaging for 30 minutes
      const windowMinutes = 10;
      const restrictMinutes = 30;
      const since = new Date(Date.now() - windowMinutes * 60_000);
      const recentBlocks = await params.prisma.securityEvent.count({
        where: {
          actorUserId: params.senderId,
          actionType: "message.blocked",
          createdAt: { gt: since },
        },
      });

      if (recentBlocks >= 3) {
        const until = computeRestrictedUntil(restrictMinutes / 60);
        const restrictionRiskBump = 50;
        try {
          await params.prisma.user.update({
            where: { id: params.senderId },
            data: { restrictedUntil: until, riskScore: { increment: restrictionRiskBump } },
          });
        } catch (e: any) {
          if (!isMissingDbColumnError(e)) throw e;
        }

        await params.logSecurityEvent(params.req, "user.restricted", {
          targetType: "USER",
          targetId: params.senderId,
          reason: "repeated_message_blocks",
          restrictedUntil: until.toISOString(),
          recentBlocks,
          windowMinutes,
          restrictMinutes,
          restrictionRiskBump,
        });

        return {
          action: "RESTRICTED",
          status: 403,
          restrictedUntil: until,
          message:
            "Your account is temporarily restricted due to repeated blocked messages. Please wait a bit and try again.",
        };
      }
    } catch {
      // ignore throttling failures
    }

    const isContactInfo = moderation.reasonCodes.includes("CONTACT_INFO");
    return {
      action: "BLOCK",
      status: 400,
      body: {
        error:
          "For your safety, sharing contact details or arranging payment off the app isn’t allowed yet. Please keep communication in-app. If you need to share details, use “Request contact exchange” on the job once it’s awarded or approved.",
        code: isContactInfo ? "CONTACT_INFO_NOT_ALLOWED" : "MESSAGE_BLOCKED",
        blocked: true,
        reasonCodes: moderation.reasonCodes,
        appealUrl: params.appealUrl,
      },
    };
  }

  // moderation ALLOW: apply scoring thresholds, but do not block
  if (riskScoreToApply >= RISK_RESTRICT_THRESHOLD) {
    const until = computeRestrictedUntil();
    try {
      await params.prisma.user.update({
        where: { id: params.senderId },
        data: { riskScore: { increment: riskScoreToApply }, restrictedUntil: until },
      });
    } catch (e: any) {
      if (!isMissingDbColumnError(e)) throw e;
    }

    await params.logSecurityEvent(params.req, "user.restricted", {
      targetType: "USER",
      targetId: params.senderId,
      reason: "message_risk_threshold",
      jobId: params.jobId,
      riskTotalScore: riskScoreToApply,
      riskSignals: risk.signals,
      restrictedUntil: until.toISOString(),
    });

    return {
      action: "RESTRICTED",
      status: 403,
      restrictedUntil: until,
      message: "Your account is temporarily restricted due to suspicious activity.",
    };
  }

  if (riskScoreToApply > 0) {
    try {
      await params.prisma.user.update({
        where: { id: params.senderId },
        data: { riskScore: { increment: riskScoreToApply } },
      });
    } catch (e: any) {
      if (!isMissingDbColumnError(e)) throw e;
    }
  }

  return { action: "ALLOW" };
}
