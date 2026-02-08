import cors from "cors";
import * as dotenv from "dotenv";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { prisma } from "./prisma";
import express = require("express");
import type { Request, Response, NextFunction } from "express";
import { AdminActionType } from "@prisma/client";
import { createRoleRateLimitRedis } from "./middleware/rateLimitRedis";
import {
  canAccessJobAttachment,
  resolveDiskPathInsideUploadsDir,
  sanitizeFilenameForHeader,
  shouldInlineContentType,
} from "./utils/attachmentsGuard";
import { createGetAttachmentHandler } from "./routes/attachments";
import { createPostJobAwardHandler } from "./routes/jobAward";
import {
  createPostJobConfirmCompleteHandler,
  createPostJobMarkCompleteHandler,
} from "./routes/jobCompletion";
import { createPostJobStartHandler } from "./routes/jobStart";
import { createPostJobCancelHandler } from "./routes/jobCancellation";
import { createGetProviderEntitlementsHandler } from "./routes/providerEntitlements";
import { createPostJobReviewsHandler } from "./routes/jobReviews";
import {
  createGetContactExchangeHandler,
  createPostContactExchangeDecideHandler,
  createPostContactExchangeRequestHandler,
} from "./routes/contactExchange";
import helmet from "helmet";
import * as crypto from "crypto";
import multer from "multer";
import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";
import { startWebhookWorker } from "./webhooks/worker";
import { authMiddleware } from "./middleware/authMiddleware";
import { env } from "./config/env";
import { requireVerifiedEmail } from "./middleware/requireVerifiedEmail";
import { sendMail } from "./services/mailer";
import { logSecurityEvent } from "./services/securityEventLogger";
import { cancellationReasonLabel } from "./services/jobCancellationReasons";
import { logger } from "./services/logger";
import { stripe } from "./services/stripeService";
import {
  createProviderAddonPaymentIntentV2,
  type LegacyProviderAddonPurchaseRequest,
  type ProviderAddonPurchaseRequestV2,
} from "./services/addonPurchasesV2";
import {
  getLeadEntitlementsFromSubscription,
  getUsageMonthKey,
  ensureSubscriptionUsageIsCurrent,
  consumeLeadIfAvailable,
} from "./services/providerEntitlements";
import { canOpenDispute, canReviewJob } from "./services/jobFlowGuards";
import {
  createPostAdminResolveDisputeHandler,
  createPostJobDisputesHandler,
} from "./routes/jobDisputes";
import { requestIdMiddleware, httpAccessLogMiddleware } from "./middleware/observability";
import { initSentry, captureException, flushSentry } from "./observability/sentry";
import { classifyJob } from "./services/jobClassifier";
import { suggestJobPrice } from "./services/jobPriceSuggester";
import {
  assessJobPostRisk,
  assessRepeatedBidMessageRisk,
  computeRestrictedUntil,
  RISK_RESTRICT_THRESHOLD,
  RISK_REVIEW_THRESHOLD,
} from "./services/riskScoring";
import { moderateJobMessageSend } from "./services/jobMessageSendModeration";
import { computeNewUploadTargets } from "./services/objectStorageUploads";
import { z } from "zod";
import { validate, type Validated, type ValidatedRequest } from "./middleware/validate";
import { enqueueBackgroundJob } from "./jobs/enqueue";
import { patchAppForAsyncErrors } from "./middleware/asyncWrap";
import { createGlobalErrorHandler } from "./middleware/globalErrorHandler";
import { createBasicAuthForAdminUi, createRequireAdminUiEnabled } from "./routes/adminWebhooksUiGuard";
import { createGetAdminOpsKpisHandler } from "./routes/adminOpsKpis";
import { normalizeZipForBoost } from "./services/providerDiscoveryRanking";
import { extractZip5, rankProvider } from "./matching/rankProviders";
import zipcodes from "zipcodes";
import {
  createGetMeNotificationPreferencesHandler,
  createPutMeNotificationPreferencesHandler,
} from "./routes/notificationPreferences";
import { getNotificationPreferencesMap, shouldSendNotification } from "./services/notificationPreferences";
import { recomputeProviderStatsForProvider } from "./services/providerStats";
import { createGetProvidersSearchHandler } from "./routes/providersSearch";
import { getCurrentMonthKeyUtc } from "./ai/aiGateway";
import { enforceAttestationForSensitiveRoutes } from "./attestation/enforceAttestationForSensitiveRoutes";
import { createLoginBruteForceProtector } from "./services/loginBruteForceProtector";
import { createAuthLoginHandler } from "./routes/authLogin";
import { createBasicAuthForMetrics, createRequireMetricsEnabled } from "./routes/metricsGuard";
import { prometheusContentType, prometheusMetricsText } from "./metrics/prometheus";
import { validateEnvAtStartup } from "./config/validateEnv";
import { createGetAdminMessageViolationsHandler } from "./routes/adminMessageViolations";
import {
  getAttachmentSignedUrlTtlSeconds,
  getObjectStorageProviderName,
  getStorageProviderOrThrow,
} from "./storage/storageFactory";

let webhookWorkerStartedAt: Date | null = null;

function restrictedResponse(res: Response, params: { message: string; restrictedUntil?: Date | null }) {
  return res.status(403).json({
    error: params.message,
    code: "RESTRICTED",
    restrictedUntil: params.restrictedUntil ?? null,
  });
}

function isRestrictedUser(req: AuthRequest): boolean {
  const until = req.user?.restrictedUntil;
  if (!until) return false;
  const ts = new Date(until).getTime();
  return Number.isFinite(ts) && ts > Date.now();
}

type UserRole = "CONSUMER" | "PROVIDER" | "ADMIN";

type AuthUser = {
  userId: number;
  role: UserRole;
  isSuspended: boolean;               // ✅ required
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  emailVerifiedAt?: Date | null;
  riskScore?: number;
  restrictedUntil?: Date | null;
  impersonatedByAdminId?: number;
  isImpersonated?: boolean;
};



async function deliverWebhook(params: {
  deliveryId: number;
  url: string;
  secret: string;
  event: string;
  payload: any;
}) {
  const { deliveryId, url, secret, event, payload } = params;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const rawBody = JSON.stringify(payload);

  // Canonical base string (VERSIONED)
  const baseString = `v1.${timestamp}.${event}.${rawBody}`;

  const signatureHex = crypto
    .createHmac("sha256", secret)
    .update(baseString, "utf8")
    .digest("hex");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GoGetter-Delivery-Id": String(deliveryId),
      "X-GoGetter-Event": event,
      "X-GoGetter-Timestamp": timestamp,
      "X-GoGetter-Signature": `v1=${signatureHex}`,
    },
    body: rawBody,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook failed: ${res.status} ${text}`);
  }
}


// Augment the Request type so we can attach user info from JWT
export interface AuthRequest extends Request {
  user?: AuthUser;
}


if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// Fail-fast startup config validation (prod throws; non-prod warns for optional features).
validateEnvAtStartup();

const app = express();
// Ensure async route errors bubble into the single global error handler.
patchAppForAsyncErrors(app);
app.set("etag", false);
app.set("trust proxy", true);
const PORT = env.PORT;
const JWT_SECRET = env.JWT_SECRET;

const objectStorageProviderName = getObjectStorageProviderName();
const attachmentStorageProvider = objectStorageProviderName === "s3" ? getStorageProviderOrThrow() : undefined;
const attachmentsSignedUrlTtlSeconds = getAttachmentSignedUrlTtlSeconds();

// Optional error reporting (Sentry)
initSentry().catch(() => null);

// --- Baseline HTTP hardening ---
// Enable Helmet defaults but:
// - manage CSP ourselves (route-specific)
// - enable HSTS in production only
app.use(
  helmet({
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
  })
);

// Global clickjacking protection (we do not embed this app in iframes).
app.use(helmet.frameguard({ action: "deny" }));

// Explicit nosniff (Helmet sets this by default; keep explicit for clarity).
app.use(helmet.xContentTypeOptions());

// Request context (req.id + X-Request-Id) and access logs
app.use(requestIdMiddleware);
app.use(httpAccessLogMiddleware);

// Scoped app attestation enforcement (no-op unless APP_ATTESTATION_ENFORCE=true)
enforceAttestationForSensitiveRoutes(app);

// --- Health endpoints ---
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: true });
  } catch (e: any) {
    logger.warn("readyz.db_unreachable", { message: String(e?.message ?? e) });
    return res.status(503).json({ ok: false, db: false });
  }
});

// --- Metrics endpoint (disabled by default) ---
const requireMetricsEnabled = createRequireMetricsEnabled(process.env);
const basicAuthForMetrics = createBasicAuthForMetrics(process.env);
app.get("/metrics", requireMetricsEnabled, basicAuthForMetrics, async (_req, res) => {
  const text = await prometheusMetricsText();
  res.setHeader("Content-Type", prometheusContentType());
  return res.status(200).send(text);
});

// Transitional CSP strategy:
// - Strict CSP for API responses (safe for JSON, file streams, etc.)
// - /admin/webhooks/ui sets its own minimal CSP to allow inlined JS/CSS for the single-file UI.
app.use((req, res, next) => {
  if (req.path === "/admin/webhooks/ui" || req.path === "/admin/ops/ui") return next();
  return helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'none'"],
      "base-uri": ["'none'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'none'"],
      "object-src": ["'none'"],
      "img-src": ["'self'", "data:"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "connect-src": ["'self'"],
    },
  })(req, res, next);
});

// Ensure Referrer-Policy is present (Helmet also sets this by default, but we keep it explicit).
app.use(helmet.referrerPolicy({ policy: "no-referrer" }));

// Ensure Permissions-Policy is present (Helmet v8 removed permissionsPolicy middleware).
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), camera=(), microphone=(), payment=(), usb=()"
  );
  return next();
});

if (process.env.NODE_ENV === "production") {
  app.use(
    helmet.hsts({
      maxAge: 15552000, // 180 days
      includeSubDomains: true,
      preload: true,
    })
  );
}

// Ensure async route handler errors are forwarded to Express error middleware.
function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => {
    try {
      const maybePromise = fn(req, res, next);
      Promise.resolve(maybePromise).catch(next);
    } catch (e) {
      next(e);
    }
  };
}

function patchExpressForAsyncErrors(appInstance: any) {
  const methods = ["get", "post", "put", "patch", "delete", "options", "head", "all"];
  const wrap = (h: any) => (typeof h === "function" && h.length < 4 ? asyncHandler(h) : h);

  for (const m of methods) {
    const orig = appInstance[m];
    if (typeof orig !== "function" || (orig as any).__asyncWrapped) continue;

    const wrapped = function (this: any, ...args: any[]) {
      if (args.length === 0) return orig.apply(this, args);
      const pathOrHandler = args[0];
      const rest = args.slice(1).map(wrap);
      return orig.call(this, pathOrHandler, ...rest);
    };
    (wrapped as any).__asyncWrapped = true;
    appInstance[m] = wrapped;
  }

  const origUse = appInstance.use;
  if (typeof origUse === "function" && !(origUse as any).__asyncWrapped) {
    const wrappedUse = function (this: any, ...args: any[]) {
      if (args.length === 0) return origUse.apply(this, args);

      if (typeof args[0] === "string" || args[0] instanceof RegExp) {
        const [path, ...handlers] = args;
        return origUse.call(this, path, ...handlers.map(wrap));
      }

      return origUse.call(this, ...args.map(wrap));
    };
    (wrappedUse as any).__asyncWrapped = true;
    appInstance.use = wrappedUse;
  }
}

patchExpressForAsyncErrors(app);

// --- Middlewares ---
const allowedOrigins =
  (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow tools like curl/postman (no origin)
      if (!origin) return cb(null, true);

      // dev: allow localhost automatically
      if ((process.env.NODE_ENV ?? "development") !== "production") {
        try {
          const u = new URL(origin);
          const host = (u.hostname || "").toLowerCase();
          if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
            return cb(null, true);
          }
        } catch {
          // fall through
        }
      }

      // production: only allow configured origins
      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);

const jsonParser = express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
});

// Stripe webhooks must receive the *raw* request body for signature verification.
// If express.json() runs first, it consumes the stream and breaks verification.
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith("/payments/webhook")) return next();
  return jsonParser(req, res, next);
});

// --- Uploads (attachments) ---
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const ATTACHMENTS_DIR = path.join(UPLOADS_DIR, "attachments");

try {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
} catch {
  // ignore
}

const MAX_ATTACHMENT_BYTES = Number(
  process.env.MAX_ATTACHMENT_BYTES ?? 15 * 1024 * 1024
);

function isAllowedAttachmentMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith("image/") || mime.startsWith("video/");
}

function isAllowedVerificationMime(mime: string | undefined): boolean {
  if (!mime) return false;
  if (mime.startsWith("image/") || mime.startsWith("video/")) return true;
  // Common verification docs
  if (mime === "application/pdf") return true;
  return false;
}

function safeUploadExt(originalName: string | undefined): string {
  const original = (originalName || "file").trim() || "file";
  const ext = path.extname(original).slice(0, 12);
  return ext && ext.startsWith(".") ? ext : "";
}

function makeUploadBasename(originalName: string | undefined): string {
  return `${crypto.randomUUID()}${safeUploadExt(originalName)}`;
}

const uploadAttachment = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number.isFinite(MAX_ATTACHMENT_BYTES)
      ? MAX_ATTACHMENT_BYTES
      : 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedAttachmentMime(file.mimetype)) {
      return cb(new Error("Unsupported file type. Only images and videos are allowed."));
    }
    cb(null, true);
  },
});

function uploadSingleAttachment(req: any, res: any, next: any) {
  return uploadAttachment.single("file")(req, res, (err: any) => {
    if (!err) return next();

    const msg = String(err?.message || "");
    const code = String(err?.code || "");

    if (code === "LIMIT_FILE_SIZE" || msg.includes("File too large")) {
      return res.status(413).json({
        error: `Attachment exceeds size limit (${MAX_ATTACHMENT_BYTES} bytes).`,
      });
    }

    if (msg.includes("Unsupported file type")) {
      return res.status(415).json({ error: msg });
    }

    console.error("Upload attachment middleware error:", err);
    return res.status(400).json({
      error: "Invalid attachment upload.",
    });
  });
}

const uploadVerificationAttachment = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number.isFinite(MAX_ATTACHMENT_BYTES)
      ? MAX_ATTACHMENT_BYTES
      : 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedVerificationMime(file.mimetype)) {
      return cb(
        new Error(
          "Unsupported file type. Only images, videos, and PDFs are allowed."
        )
      );
    }
    cb(null, true);
  },
});

function uploadSingleVerificationAttachment(req: any, res: any, next: any) {
  return uploadVerificationAttachment.single("file")(req, res, (err: any) => {
    if (!err) return next();

    const msg = String(err?.message || "");
    const code = String(err?.code || "");

    if (code === "LIMIT_FILE_SIZE" || msg.includes("File too large")) {
      return res.status(413).json({
        error: `Attachment exceeds size limit (${MAX_ATTACHMENT_BYTES} bytes).`,
      });
    }

    if (msg.includes("Unsupported file type")) {
      return res.status(415).json({ error: msg });
    }

    console.error("Upload verification attachment middleware error:", err);
    return res.status(400).json({
      error: "Invalid verification attachment upload.",
    });
  });
}

const attachmentDownloadLimiter = createRoleRateLimitRedis({
  bucket: "attachment_download",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 120, PROVIDER: 180, ADMIN: 600 },
  message: "Too many attachment downloads. Please slow down.",
});

function attachmentPublicUrl(req: Request, attachmentId: number) {
  const publicBase =
    (process.env.PUBLIC_BASE_URL ?? "").trim() ||
    `${req.protocol}://${req.get("host")}`;
  return `${publicBase}/attachments/${attachmentId}`;
}

// GET /attachments/:id
// Streams an attachment from disk if caller is authorized (consumer owner, provider with bid, or admin).
app.get(
  "/attachments/:id",
  authMiddleware,
  attachmentDownloadLimiter,
  createGetAttachmentHandler({
    prisma: prisma as any,
    uploadsDir: UPLOADS_DIR,
    storageProvider: attachmentStorageProvider,
    signedUrlTtlSeconds: attachmentsSignedUrlTtlSeconds,
  })
);


import adminWebhooksRouter from "./routes/adminWebhooks";
import paymentsRouter from "./routes/payments";
import adRevenueRouter from "./routes/adRevenue";
import payoutsRouter from "./routes/payouts";

app.use("/admin", adminWebhooksRouter);
app.use("/payments", paymentsRouter);
app.use("/ad-revenue", adRevenueRouter);
app.use("/payouts", payoutsRouter);



function timingSafeEqualHex(a: string, b: string) {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifyGoGetterWebhook(secret: string, toleranceSeconds = 300) {
  return (req: any, res: any, next: any) => {
    const deliveryId = req.header("X-GoGetter-Delivery-Id");
    const event = req.header("X-GoGetter-Event");
    const timestamp = req.header("X-GoGetter-Timestamp");
    const sigHeader = req.header("X-GoGetter-Signature");

    if (!deliveryId || !event || !timestamp || !sigHeader) {
      return res.status(400).json({ error: "Missing webhook headers." });
    }

    const match = /^v1=([0-9a-f]{64})$/i.exec(sigHeader);
    if (!match) return res.status(400).json({ error: "Invalid signature format." });

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return res.status(400).json({ error: "Invalid timestamp." });

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSeconds) {
      return res.status(400).json({ error: "Webhook timestamp outside tolerance." });
    }

    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const baseString = `v1.${timestamp}.${event}.${rawBody}`;
    const expected = crypto.createHmac("sha256", secret).update(baseString, "utf8").digest("hex");

    if (!timingSafeEqualHex(expected, match[1])) {
      return res.status(401).json({ error: "Invalid signature." });
    }

    // attach for handlers
    req.webhook = { deliveryId, event, timestamp: ts };

    return next();
  };
}

const loginLimiter = createRoleRateLimitRedis({
  bucket: "auth_login",
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 10, PROVIDER: 10, ADMIN: 30 },
  message: "Too many login attempts. Try again in a minute.",
});

const signupLimiter = createRoleRateLimitRedis({
  bucket: "auth_signup",
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 5, PROVIDER: 5, ADMIN: 10 },
  message: "Too many signup attempts. Try again in a minute.",
});

const verifyEmailLimiter = createRoleRateLimitRedis({
  bucket: "auth_verify_email",
  windowMs: 60_000,
  limits: { UNKNOWN: 10, CONSUMER: 15, PROVIDER: 15, ADMIN: 30 },
  message: "Too many verification attempts. Try again in a minute.",
});

const forgotPasswordLimiter = createRoleRateLimitRedis({
  bucket: "auth_forgot_password",
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 10, PROVIDER: 10, ADMIN: 30 },
  message: "Too many password reset requests. Try again in a minute.",
});

const resetPasswordLimiter = createRoleRateLimitRedis({
  bucket: "auth_reset_password",
  windowMs: 60_000,
  limits: { UNKNOWN: 5, CONSUMER: 10, PROVIDER: 10, ADMIN: 30 },
  message: "Too many password reset attempts. Try again in a minute.",
});

const loginBruteForce = createLoginBruteForceProtector();

const messageLimiter = createRoleRateLimitRedis({
  bucket: "message_read",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 30, PROVIDER: 45, ADMIN: 200 },
  message: "Too many messages in a short time. Please slow down.",
});

const bidLimiter = createRoleRateLimitRedis({
  bucket: "bid_place",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 0, PROVIDER: 15, ADMIN: 100 },
  message: "Too many bids in a short time. Please slow down.",
});

const jobCreateLimiter = createRoleRateLimitRedis({
  bucket: "job_create",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 10, PROVIDER: 0, ADMIN: 60 },
  message: "Too many job posts in a short time. Please slow down.",
});

const messageSendLimiter = createRoleRateLimitRedis({
  bucket: "message_send",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 20, PROVIDER: 30, ADMIN: 200 },
  message: "Too many messages in a short time. Please slow down.",
});

const reportLimiter = createRoleRateLimitRedis({
  bucket: "report_create",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 5, PROVIDER: 5, ADMIN: 200 },
  message: "Too many reports in a short time. Please slow down.",
});

const notificationsLimiter = createRoleRateLimitRedis({
  bucket: "notifications_read",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 60, PROVIDER: 60, ADMIN: 300 },
  message: "Too many notification refreshes. Please slow down.",
});

const contactExchangeRequestLimiter = createRoleRateLimitRedis({
  bucket: "contact_exchange_request",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 3, PROVIDER: 3, ADMIN: 50 },
  message: "Too many contact exchange requests. Please slow down.",
});

const contactExchangeDecideLimiter = createRoleRateLimitRedis({
  bucket: "contact_exchange_decide",
  windowMs: 60_000,
  limits: { UNKNOWN: 0, CONSUMER: 10, PROVIDER: 10, ADMIN: 200 },
  message: "Too many requests. Please slow down.",
});


// --- Auth middleware (allows suspended users; used ONLY for /me) ---
const authAllowSuspended = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res.status(401).json({ error: "Invalid Authorization header format" });
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET) as { userId: number; role: string };

    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        role: true,
        isSuspended: true,
        suspendedAt: true,
        suspendedReason: true,
        emailVerifiedAt: true,
      },
    });

    if (!dbUser) return res.status(401).json({ error: "User not found for token" });

    req.user = {
      userId: dbUser.id,
      role: dbUser.role,
      isSuspended: dbUser.isSuspended,
      suspendedAt: dbUser.suspendedAt,
      suspendedReason: dbUser.suspendedReason,
      emailVerifiedAt: dbUser.emailVerifiedAt,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// --- Notification helper ---
// Simple wrapper so we don't repeat prisma.notification.create everywhere
async function createNotification(params: {
  userId: number;
  type: string;
  content: any;
}) {
  const { userId, type, content } = params;
  try {
    await prisma.notification.create({
      data: {
        userId,
        type,
        content,
      },
    });
  } catch (err) {
    console.error("Error creating notification:", err);
    // We don't throw, because we don't want a notification failure
    // to break the main action (placing a bid, sending a message, etc.)
  }
}

const upsertPushTokenSchema = {
  body: z.object({
    token: z.string().trim().min(8, "token is required"),
    platform: z.string().trim().min(1).optional().nullable(),
  }),
};

function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

function validatePasswordPolicy(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  const p = password;
  if (p.length < 12) return "Password must be at least 12 characters.";

  const deny = new Set(
    [
      "password",
      "password123",
      "123456789012",
      "qwertyuiop",
      "letmein",
      "welcome",
      "adminadmin",
      "iloveyou",
      "111111111111",
    ].map((s) => s.toLowerCase())
  );

  const lowered = p.trim().toLowerCase();
  if (deny.has(lowered)) return "Password is too common.";

  // Quick extra guard: reject passwords containing the word "password"
  if (lowered.includes("password")) return "Password is too common.";

  return null;
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Invalid email");

const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .superRefine((val, ctx) => {
    const err = validatePasswordPolicy(val);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });

const positiveIntSchema = z.coerce
  .number()
  .int("Must be an integer")
  .positive("Must be a positive integer");

const idParamsSchema = z.object({ id: positiveIntSchema });
const userIdParamsSchema = z.object({ userId: positiveIntSchema });
const jobIdParamsSchema = z.object({ jobId: positiveIntSchema });
const jobBidParamsSchema = z.object({ jobId: positiveIntSchema, bidId: positiveIntSchema });
const bidIdParamsSchema = z.object({ bidId: positiveIntSchema });

const subscriptionTierSchema = z.enum(["FREE", "BASIC", "PRO"]);
const subscriptionUpgradeTierSchema = z.enum(["BASIC", "PRO"]);
const subscriptionDowngradeTierSchema = z.enum(["FREE", "BASIC"]);

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function randomToken(): string {
  // base64url without padding
  return crypto.randomBytes(32).toString("base64url");
}

function publicAppUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.WEB_APP_URL ||
    // sensible dev fallback
    "http://localhost:8081"
  );
}

// Simple pricing function for subscription tiers (amount in cents)
function getSubscriptionPriceCents(tier: "FREE" | "BASIC" | "PRO"): number {
  switch (tier) {
    case "BASIC":
      return 500; // $5.00
    case "PRO":
      return 1000; // $10.00
    case "FREE":
    default:
      return 0;
  }
}

function parsePositiveInt(value: unknown, fallback: number, max?: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const i = Math.floor(n);
  if (max != null) return Math.min(i, max);
  return i;
}

function parseOptionalCursorId(value: unknown) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function signWebhookPayload(secret: string, payload: any, timestamp: number) {
  const body = JSON.stringify(payload);
  const signed = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, signature: signed };
}

// --- Webhook helper ---
// Finds endpoints subscribed to an eventType and creates delivery rows for async processing.
async function enqueueWebhookEvent(args: { eventType: string; payload: Record<string, any> }) {
  const { eventType, payload } = args;

  console.log("[WEBHOOK enqueue]", eventType); // ✅ TEMP

  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { enabled: true, events: { has: eventType } },
      select: { id: true },
    });

    console.log("[WEBHOOK endpoints matched]", endpoints.length); // ✅ TEMP

    if (endpoints.length === 0) return;

    await prisma.webhookDelivery.createMany({
      data: endpoints.map((e) => ({
        endpointId: e.id,
        event: eventType,
        payload,
        status: "PENDING",
        attempts: 0,
        nextAttempt: new Date(),
      })),
    });

    console.log("[WEBHOOK deliveries created]", endpoints.length); // ✅ TEMP
  } catch (err) {
    console.error("Failed to enqueue webhook event:", eventType, err);
  }
}

function computeNextAttempt(attempts: number) {
  // simple exponential-ish backoff: 30s, 60s, 120s, 240s...
  const base = Number(process.env.WEBHOOK_RETRY_SECONDS ?? 30);
  const delaySeconds = base * Math.pow(2, Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}

function moderateReviewText(text: string | null): { ok: true; text: string | null } | { ok: false; error: string } {
  const trimmed = text?.trim() || "";
  if (!trimmed) return { ok: true, text: null };

  // Very small stub ruleset (expand later): block obvious PII + profanity
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  if (emailRegex.test(trimmed)) {
    return { ok: false, error: "Review text cannot include email addresses." };
  }

  const phoneRegex = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/;
  if (phoneRegex.test(trimmed)) {
    return { ok: false, error: "Review text cannot include phone numbers." };
  }

  const profanity = ["fuck", "shit", "bitch", "cunt"]; // stub
  const profanityRegex = new RegExp(`\\b(${profanity.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  if (profanityRegex.test(trimmed)) {
    return { ok: false, error: "Review text contains disallowed language." };
  }

  return { ok: true, text: trimmed };
}


// Recompute and update a provider's average rating + review count
async function recomputeProviderRating(providerId: number) {
  // 1) Aggregate over all reviews for this provider
  const agg = await prisma.review.aggregate({
    where: { revieweeUserId: providerId },
    _avg: { rating: true },
    _count: { _all: true },
  });

  const avgRating = agg._avg.rating ?? null;
  const totalReviews = agg._count._all ?? 0;

  // 2) Upsert ProviderProfile in case it somehow doesn't exist yet
  await prisma.providerProfile.upsert({
    where: { providerId },
    update: {
      rating: avgRating,
      reviewCount: totalReviews,
    },
    create: {
      providerId,
      rating: avgRating,
      reviewCount: totalReviews,
    },
  });

  return {
    averageRating: avgRating,
    reviewCount: totalReviews,
  };
}

const DEFAULT_CATEGORIES = [
  { name: "Handyman", slug: "handyman" },
  { name: "Electrician", slug: "electrician" },
  { name: "Plumber", slug: "plumber" },
  { name: "Cleaner", slug: "cleaner" },
  { name: "Painter", slug: "painter" },
];

async function seedCategories() {
  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: cat,
    });
  }
}

// Check if either user has blocked the other
async function isBlockedBetween(userAId: number, userBId: number): Promise<boolean> {
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userAId, blockedId: userBId },
        { blockerId: userBId, blockedId: userAId },
      ],
    },
  });

  return !!block;
}

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }

  // 🚫 Impersonated sessions are NEVER allowed admin access
  if (req.user.isImpersonated) {
    res.status(403).json({
      error: "Admin access not allowed while impersonating a user.",
    });
    return false;
  }

  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "Admin access only." });
    return false;
  }

  return true;
}

// GET /admin/ai-usage (admin only)
app.get("/admin/ai-usage", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const monthKey = getCurrentMonthKeyUtc();
    const limit = Math.max(1, Math.min(200, Number((req.query as any)?.limit ?? 50)));

    const users = await prisma.user.findMany({
      where: {
        aiUsageMonthKey: monthKey,
        aiTokensUsedThisMonth: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        aiMonthlyTokenLimit: true,
        aiTokensUsedThisMonth: true,
        aiUsageMonthKey: true,
        subscription: { select: { tier: true } },
      },
      orderBy: [{ aiTokensUsedThisMonth: "desc" }, { id: "asc" }],
      take: limit,
    });

    const totalsByTier: Record<string, { users: number; tokensUsed: number }> = {};
    for (const u of users) {
      const tier = String(u.subscription?.tier ?? "FREE");
      if (!totalsByTier[tier]) totalsByTier[tier] = { users: 0, tokensUsed: 0 };
      totalsByTier[tier].users += 1;
      totalsByTier[tier].tokensUsed += Number(u.aiTokensUsedThisMonth ?? 0);
    }

    const cacheTtlDays = Number(process.env.AI_CACHE_TTL_DAYS ?? 30);
    const ttlMs = Number.isFinite(cacheTtlDays) && cacheTtlDays > 0 ? cacheTtlDays * 24 * 60 * 60 * 1000 : 0;
    const now = new Date();
    const cacheTotal = await prisma.aiCacheEntry.count().catch(() => 0);
    const cacheActive = ttlMs
      ? await prisma.aiCacheEntry
          .count({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } })
          .catch(() => 0)
      : cacheTotal;

    return res.json({
      monthKey,
      topUsers: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        tier: u.subscription?.tier ?? "FREE",
        aiMonthlyTokenLimit: u.aiMonthlyTokenLimit ?? null,
        aiTokensUsedThisMonth: u.aiTokensUsedThisMonth ?? 0,
      })),
      totalsByTier,
      cache: {
        ttlDays: ttlMs ? cacheTtlDays : null,
        totalEntries: cacheTotal,
        activeEntries: cacheActive,
      },
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // Deploy-safe if the migration hasn't been applied yet.
    if ((/column/i.test(msg) || /relation/i.test(msg)) && /does not exist/i.test(msg)) {
      return res.json({
        monthKey: getCurrentMonthKeyUtc(),
        enabled: false,
        error: "AI usage tracking schema not migrated yet.",
      });
    }

    console.error("GET /admin/ai-usage error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});


async function logAdminAction(args: {
  adminId: number;
  type: AdminActionType;
  reportId?: number | null;
  entityId?: number | null;
  notes?: string | null;
}) {
  const { adminId, type, reportId = null, entityId = null, notes = null } = args;

  return prisma.adminAction.create({
    data: {
      adminId,
      type,
      reportId,
      entityId,
      notes,
    },
  });
}

function isAdmin(req: AuthRequest) {
  return req.user?.role === "ADMIN";
}

function visibilityFilters(req: AuthRequest) {
  // Only restrict visibility for non-admins
  if (isAdmin(req)) {
    return {
      userWhereVisible: {},
      jobWhereVisible: {},
      messageWhereVisible: {},
    };
  }

  return {
    // Users visible to the public
    userWhereVisible: {
      isSuspended: false,
    },

    // Jobs visible to the public
    jobWhereVisible: {
      isHidden: false,
      consumer: { isSuspended: false },
    },

    // Messages visible to the public
    messageWhereVisible: {
      isHidden: false,
    },
  };
}

const processed = new Set<string>(); // replace with DB table in real usage

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "home-hero-backend",
    env: process.env.NODE_ENV ?? "development",
    time: new Date().toISOString(),
  });
});


app.get("/health/db", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      ok: true,
      db: "up",
      time: new Date().toISOString(),
    });
  } catch (e: any) {
    return res.status(503).json({
      ok: false,
      db: "down",
      error: e?.message ?? String(e),
      time: new Date().toISOString(),
    });
  }
});

app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      db: "ok",
      worker: webhookWorkerStartedAt ? "running" : "unknown",
      workerStartedAt: webhookWorkerStartedAt?.toISOString() ?? null,
      time: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(503).json({
      ok: false,
      db: "down",
      error: e?.message ?? String(e),
      time: new Date().toISOString(),
    });
  }
});


app.post(
  "/webhooks/gogetter",
  validate({ body: z.any() }),
  verifyGoGetterWebhook(process.env.GOGETTER_WEBHOOK_SECRET!),
  (req: any, res: any) => {
  const { deliveryId, event } = req.webhook;

  // idempotency: safe replays
  if (processed.has(deliveryId)) return res.status(200).json({ ok: true, deduped: true });
  processed.add(deliveryId);

  // handle events
  switch (event) {
    case "thread.read":
      // do stuff with req.body
      break;
    case "notification.read":
      break;
  }

  return res.status(200).json({ ok: true });
});

// GET /categories → list all provider categories
app.get("/categories", async (req: Request, res: Response) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
    });

    return res.json(
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
      }))
    );
  } catch (err) {
    console.error("GET /categories error:", err);
    return res.status(500).json({
      error: "Internal server error while fetching categories.",
    });
  }
});


// TEMP: seed categories (call once, then comment out/remove)
app.post("/dev/seed-categories", validate({}), async (req: Request, res: Response) => {
  try {
    await seedCategories();
    return res.json({ message: "Categories seeded." });
  } catch (err) {
    console.error("seedCategories error:", err);
    return res.status(500).json({ error: "Failed to seed categories." });
  }
});




// GET /me  → current user's info (should work even if suspended)
app.get("/me", authAllowSuspended, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const me = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        subscription: true,
        providerProfile: true,
      },
    });

    if (!me) {
      return res.status(404).json({ error: "User not found." });
    }

    return res.json({
      id: me.id,
      role: me.role,
      name: me.name,
      email: me.email,
      phone: me.phone,
      location: me.location,
      createdAt: me.createdAt,

      // ✅ suspension fields so the frontend can show the banner
      isSuspended: me.isSuspended,
      suspendedAt: me.suspendedAt,
      suspendedReason: me.suspendedReason,

      subscription: me.subscription
        ? {
            tier: me.subscription.tier,
            renewsAt: me.subscription.renewsAt,
            createdAt: me.subscription.createdAt,
          }
        : null,

      // optional: provider profile fields (if provider)
      providerProfile: me.providerProfile
        ? {
            experience: me.providerProfile.experience,
            specialties: me.providerProfile.specialties,
            rating: me.providerProfile.rating,
            reviewCount: me.providerProfile.reviewCount,
          }
        : null,
    });
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ error: "Internal server error while fetching /me." });
  }
});

// POST /me/push-token  → save Expo push token for current user (best-effort)
app.post(
  "/me/push-token",
  authMiddleware,
  requireVerifiedEmail,
  validate(upsertPushTokenSchema),
  async (req: (AuthRequest & ValidatedRequest<typeof upsertPushTokenSchema>), res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const { token, platform } = req.validated.body;

      try {
        await prisma.pushToken.upsert({
          where: { token },
          create: {
            token,
            platform: platform ?? null,
            lastSeenAt: new Date(),
            userId: req.user.userId,
          },
          update: {
            platform: platform ?? undefined,
            lastSeenAt: new Date(),
            userId: req.user.userId,
          },
        });
      } catch (err: any) {
        const msg = String(err?.message ?? "");
        // Deploy-safe: ignore if migration hasn't been applied yet.
        if (isMissingDbColumnError(err) || /relation/i.test(msg) && /does not exist/i.test(msg)) {
          return res.json({ ok: true, stored: false });
        }
        throw err;
      }

      return res.json({ ok: true, stored: true });
    } catch (err) {
      console.error("POST /me/push-token error:", err);
      return res.status(500).json({ error: "Internal server error while saving push token." });
    }
  }
);

// GET /me/notification-preferences
app.get(
  "/me/notification-preferences",
  authMiddleware,
  createGetMeNotificationPreferencesHandler({ prisma })
);

// PUT /me/notification-preferences
app.put(
  "/me/notification-preferences",
  authMiddleware,
  createPutMeNotificationPreferencesHandler({ prisma })
);


// -----------------------------
// Subscription endpoints
// -----------------------------

async function handleGetSubscription(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { subscription: true, providerProfile: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const now = new Date();
    const monthKey = getUsageMonthKey(now);

    let entitlements:
      | ReturnType<typeof getLeadEntitlementsFromSubscription>
      | null = null;

    if (req.user.role === "PROVIDER") {
      const sub = await prisma.$transaction(async (tx) =>
        ensureSubscriptionUsageIsCurrent(tx, req.user!.userId, now)
      );

      entitlements = getLeadEntitlementsFromSubscription({
        tier: sub.tier,
        usageMonthKey: sub.usageMonthKey || monthKey,
        leadsUsedThisMonth: sub.leadsUsedThisMonth,
        extraLeadCreditsThisMonth: sub.extraLeadCreditsThisMonth,
      });
    }

    const tier = entitlements?.tier ?? user.subscription?.tier ?? "FREE";

    // Backward-compat fields used by the mobile app
    const bidLimitPer30Days = entitlements
      ? entitlements.baseLeadLimitThisMonth + entitlements.extraLeadCreditsThisMonth
      : null;
    const bidsUsedLast30Days = entitlements ? entitlements.leadsUsedThisMonth : null;
    const remainingBids = entitlements ? entitlements.remainingLeadsThisMonth : null;

    return res.json({
      userId: user.id,
      role: user.role,
      tier,
      bidLimitPer30Days,
      bidsUsedLast30Days,
      remainingBids,
      usageMonthKey: entitlements?.usageMonthKey ?? monthKey,
      baseLeadLimitThisMonth: entitlements?.baseLeadLimitThisMonth ?? null,
      extraLeadCreditsThisMonth: entitlements?.extraLeadCreditsThisMonth ?? null,
      leadsUsedThisMonth: entitlements?.leadsUsedThisMonth ?? null,
      remainingLeadsThisMonth: entitlements?.remainingLeadsThisMonth ?? null,
      providerAddons:
        user.providerProfile && req.user.role === "PROVIDER"
          ? {
              verificationBadge: user.providerProfile.verificationBadge,
              featuredZipCodes: user.providerProfile.featuredZipCodes,
            }
          : null,
    });
  } catch (err) {
    console.error("GET /subscription error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching subscription." });
  }
}

// --- Subscription: get my current subscription + bid usage ---
// GET /subscription
app.get("/subscription", authMiddleware, handleGetSubscription);

// GET /provider/subscription (alias)
app.get("/provider/subscription", authMiddleware, handleGetSubscription);

const purchaseAddonSchema = {
  body: z.union([
    // New (v2) payload expected by newer mobile clients
    z.discriminatedUnion("addonType", [
      z.object({ addonType: z.literal("VERIFICATION_BADGE") }),
      z.object({ addonType: z.literal("FEATURED_ZIP"), zipCode: z.string().trim().min(1).max(16) }),
      z.object({ addonType: z.literal("LEAD_PACK"), packSize: z.coerce.number().int().positive().max(100_000) }),
    ]),
    // Legacy payload (backward-compat)
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("EXTRA_LEADS"),
        quantity: z.coerce.number().int().positive().max(10_000),
      }),
      z.object({
        type: z.literal("VERIFICATION_BADGE"),
      }),
      z.object({
        type: z.literal("FEATURED_ZIP_CODES"),
        zipCodes: z.array(z.string().trim().min(1).max(16)).min(1).max(50),
      }),
    ]),
  ]),
};

// POST /provider/addons/purchase
// Creates a Stripe payment intent for an add-on purchase.
// The client may call POST /payments/confirm after Stripe succeeds to refresh UI state,
// but entitlements are granted only via Stripe webhooks.
app.post(
  "/provider/addons/purchase",
  authMiddleware,
  requireVerifiedEmail,
  validate(purchaseAddonSchema),
  async (req: AuthRequest & { validated: Validated<typeof purchaseAddonSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can purchase add-ons." });
      }

      const body = req.validated.body as any;
      const input: ProviderAddonPurchaseRequestV2 | LegacyProviderAddonPurchaseRequest =
        body && typeof body === "object" && "addonType" in body
          ? (body as ProviderAddonPurchaseRequestV2)
          : (body as LegacyProviderAddonPurchaseRequest);

      const { clientSecret, paymentIntentId, addonPurchaseId } = await createProviderAddonPaymentIntentV2({
        providerId: req.user.userId,
        input,
        deps: { stripe, prisma },
      });

      await logSecurityEvent(req, "provider.addon_purchase_intent_created", {
        targetType: "USER",
        targetId: req.user.userId,
        addon: input,
        paymentIntentId,
        addonPurchaseId,
      });

      return res.json({ clientSecret, paymentIntentId });
    } catch (err: any) {
      console.error("POST /provider/addons/purchase error:", err);
      return res.status(500).json({ error: "Internal server error while creating add-on purchase intent." });
    }
  }
);

// GET /provider/entitlements
// Returns current provider entitlements/perks granted by add-on purchases.
app.get(
  "/provider/entitlements",
  authMiddleware,
  createGetProviderEntitlementsHandler({ prisma })
);


// POST /subscription/upgrade
// Body: { tier: "BASIC" | "PRO" }
app.post(
  "/subscription/upgrade",
  authMiddleware,
  requireVerifiedEmail,
  validate({ body: z.object({ tier: subscriptionUpgradeTierSchema }) }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { tier } = (req as any).validated.body as {
        tier: z.infer<typeof subscriptionUpgradeTierSchema>;
      };

      await logSecurityEvent(req, "subscription.mutation_blocked", {
        targetType: "SUBSCRIPTION",
        targetId: String(req.user.userId),
        requestedTier: tier,
        reason: "subscription_tier_can_only_change_via_stripe_webhooks",
        route: "/subscription/upgrade",
      });

      return res.status(403).json({
        error:
          "Subscription changes are only applied by Stripe webhooks. Use /payments/create-intent and complete payment, then rely on webhook processing.",
      });
    } catch (err) {
      console.error("POST /subscription/upgrade error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while upgrading subscription." });
    }
});

// POST /subscription/downgrade  → downgrade my tier (FREE by default)
// Body: { tier?: "FREE" | "BASIC" }
app.post(
  "/subscription/downgrade",
  authMiddleware,
  requireVerifiedEmail,
  validate({ body: z.object({ tier: subscriptionDowngradeTierSchema.optional() }) }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { tier: requestedTier } = (req as any).validated.body as {
        tier?: z.infer<typeof subscriptionDowngradeTierSchema>;
      };

      await logSecurityEvent(req, "subscription.mutation_blocked", {
        targetType: "SUBSCRIPTION",
        targetId: String(req.user.userId),
        requestedTier: requestedTier ?? null,
        reason: "subscription_tier_can_only_change_via_stripe_webhooks",
        route: "/subscription/downgrade",
      });

      return res.status(403).json({
        error:
          "Subscription changes are only applied by Stripe webhooks. Downgrades/cancellations must be processed via Stripe and reflected by webhook updates.",
      });
    } catch (err) {
      console.error("POST /subscription/downgrade error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while downgrading subscription." });
    }
});

// GET /payments/subscriptions → list subscription payments for current user
app.get(
  "/payments/subscriptions",
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const payments = await prisma.subscriptionPayment.findMany({
        where: { userId: req.user.userId },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        payments.map((p) => ({
          id: p.id,
          tier: p.tier,
          amount: p.amount,
          status: p.status,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }))
      );
    } catch (err) {
      console.error("GET /payments/subscriptions error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching subscription payments.",
      });
    }
  }
);


// --- AUTH: SIGNUP ---
// POST /auth/signup
// Body: { role, name, email, password, phone?, location? }
const signupSchema = {
  body: z.object({
    role: z.enum(["CONSUMER", "PROVIDER"]),
    name: z.string().trim().min(1, "name is required"),
    email: emailSchema,
    password: passwordSchema,
    phone: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
  }),
};

app.post(
  "/auth/signup",
  signupLimiter,
  validate(signupSchema),
  async (req: ValidatedRequest<typeof signupSchema>, res) => {
  try {
    const { role, name, email, password, phone, location } = req.validated.body;

    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email },
    });

    if (existing) {
      return res.status(409).json({
        error: "A user with this email already exists.",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(String(password), 10);

    const verifyToken = randomToken();
    const verifyTokenHash = sha256Hex(verifyToken);
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Create user + subscription (+ provider profile if needed)
    const user = await prisma.user.create({
      data: {
        role, // "CONSUMER" or "PROVIDER"
        name,
        email,
        passwordHash,
        phone,
        location,
        emailVerifiedAt: null,
        emailVerificationTokenHash: verifyTokenHash,
        emailVerificationExpiresAt: verifyExpiresAt,
        subscription: {
          create: {
            tier: "FREE",
          },
        },
        ...(role === "PROVIDER"
          ? {
              providerProfile: {
                create: {},
              },
            }
          : {}),
      },
      include: {
        subscription: true,
        providerProfile: true,
      },
    });

    // ✅ Webhook event (after user is created)
    // Keep payload non-sensitive (no passwordHash, no raw password).
    await enqueueWebhookEvent({
      eventType: "user.signed_up",
      payload: {
        userId: user.id,
        role: user.role,
        name: user.name,
        email: user.email, // if you prefer less PII, remove this and rely on userId only
        phone: user.phone ?? null,
        location: user.location ?? null,
        subscriptionTier: user.subscription?.tier ?? "FREE",
        createdAt: user.createdAt,
      },
    });

    const verifyLink = `${publicAppUrl().replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(
      verifyToken
    )}`;

    await sendMail({
      to: user.email,
      subject: "Verify your Home Hero email",
      text: `Welcome to Home Hero!\n\nVerify your email using this link:\n${verifyLink}\n\nIf you did not create an account, you can ignore this email.`,
    });

    await logSecurityEvent(req, "auth.signup", {
      actorUserId: user.id,
      actorRole: user.role,
      actorEmail: user.email,
      targetType: "USER",
      targetId: user.id,
      role: user.role,
    });

    // Create JWT
    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        subscriptionTier: user.subscription?.tier ?? "FREE",
        emailVerified: Boolean(user.emailVerifiedAt),
      },
      needsEmailVerification: !user.emailVerifiedAt,
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ error: "Internal server error during signup." });
  }
});

// --- AUTH: VERIFY EMAIL ---
// POST /auth/verify-email
// Body: { token }
const verifyEmailSchema = {
  body: z.object({ token: z.string().trim().min(1, "token is required") }),
};

app.post(
  "/auth/verify-email",
  verifyEmailLimiter,
  validate(verifyEmailSchema),
  async (req: ValidatedRequest<typeof verifyEmailSchema>, res) => {
  try {
    const raw = req.validated.body.token;

    const tokenHash = sha256Hex(raw);
    const now = new Date();

    const user = await prisma.user.findUnique({
      where: { emailVerificationTokenHash: tokenHash },
      select: { id: true, email: true, emailVerifiedAt: true, emailVerificationExpiresAt: true },
    });

    if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt <= now) {
      await logSecurityEvent(req, "auth.verify_email_failed", {
        reason: "token_invalid_or_expired",
      });
      return res.status(400).json({ error: "Invalid or expired verification token." });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: user.emailVerifiedAt ?? now,
        emailVerificationTokenHash: null,
        emailVerificationExpiresAt: null,
      },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    await logSecurityEvent(req, "auth.verify_email", {
      actorUserId: updated.id,
      actorEmail: updated.email,
      targetType: "USER",
      targetId: updated.id,
    });

    return res.json({ ok: true, emailVerifiedAt: updated.emailVerifiedAt });
  } catch (err) {
    console.error("Verify email error:", err);
    return res.status(500).json({ error: "Internal server error during email verification." });
  }
});

// --- AUTH: LOGIN ---
// POST /auth/login
// Body: { email, password }
const loginSchema = {
  body: z.object({
    email: emailSchema,
    password: z.string().min(1, "password is required"),
  }),
};

app.post(
  "/auth/login",
  loginLimiter,
  validate(loginSchema),
  createAuthLoginHandler({
    prisma,
    bcryptCompare: bcrypt.compare,
    jwtSign: jwt.sign,
    jwtSecret: JWT_SECRET,
    logSecurityEvent,
    loginBruteForce,
  })
);

// --- AUTH: FORGOT PASSWORD ---
// POST /auth/forgot-password
// Body: { email }
const forgotPasswordSchema = {
  body: z.object({
    email: emailSchema.optional(),
  }),
};

app.post(
  "/auth/forgot-password",
  forgotPasswordLimiter,
  validate(forgotPasswordSchema),
  async (req: ValidatedRequest<typeof forgotPasswordSchema>, res) => {
  try {
    const normalizedEmail = req.validated.body.email ?? null;

    // Always return ok to avoid user enumeration.
    if (!normalizedEmail) {
      await logSecurityEvent(req, "auth.forgot_password", { emailProvided: false });
      return res.json({ ok: true });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    if (user) {
      const token = randomToken();
      const tokenHash = sha256Hex(token);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: expiresAt,
        },
      });

      const resetLink = `${publicAppUrl().replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(
        token
      )}`;

      await sendMail({
        to: user.email,
        subject: "Reset your Home Hero password",
        text: `We received a request to reset your password.\n\nReset using this link:\n${resetLink}\n\nIf you did not request this, you can ignore this email.`,
      });

      await logSecurityEvent(req, "auth.forgot_password", {
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: "USER",
        targetId: user.id,
      });
    } else {
      await logSecurityEvent(req, "auth.forgot_password", {
        actorEmail: normalizedEmail,
        userFound: false,
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Internal server error during forgot password." });
  }
});

// --- AUTH: RESET PASSWORD ---
// POST /auth/reset-password
// Body: { token, newPassword }
const resetPasswordSchema = {
  body: z.object({
    token: z.string().trim().min(1, "token is required"),
    newPassword: passwordSchema,
  }),
};

app.post(
  "/auth/reset-password",
  resetPasswordLimiter,
  validate(resetPasswordSchema),
  async (req: ValidatedRequest<typeof resetPasswordSchema>, res) => {
  try {
    const raw = req.validated.body.token;
    const newPassword = req.validated.body.newPassword;

    const tokenHash = sha256Hex(raw);
    const now = new Date();

    const user = await prisma.user.findUnique({
      where: { passwordResetTokenHash: tokenHash },
      select: { id: true, email: true, passwordResetExpiresAt: true },
    });

    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt <= now) {
      await logSecurityEvent(req, "auth.reset_password_failed", {
        reason: "token_invalid_or_expired",
      });
      return res.status(400).json({ error: "Invalid or expired reset token." });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    await logSecurityEvent(req, "auth.reset_password", {
      actorUserId: user.id,
      actorEmail: user.email,
      targetType: "USER",
      targetId: user.id,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Internal server error during reset password." });
  }
});

// --- Jobs: create job (CONSUMER only) ---
// POST /jobs
// Body: { title, description, budgetMin?, budgetMax?, location? }
const createJobSchema = {
  body: z.object({
    title: z.string().trim().min(1, "title is required"),
    description: z.string().trim().min(1, "description is required"),
    budgetMin: z.number().int().positive().optional().nullable(),
    budgetMax: z.number().int().positive().optional().nullable(),
    location: z.string().trim().min(1).optional().nullable(),
  }),
};

// --- Jobs: suggested price range (CONSUMER only) ---
// POST /jobs/suggest-price
// Body: { title, description, location? }
const suggestPriceSchema = {
  body: z.object({
    title: z.string().trim().min(1, "title is required"),
    description: z.string().trim().min(1, "description is required"),
    location: z.string().trim().min(1).optional().nullable(),
  }),
};

app.post(
  "/jobs/suggest-price",
  authMiddleware,
  requireVerifiedEmail,
  validate(suggestPriceSchema),
  async (req: (AuthRequest & ValidatedRequest<typeof suggestPriceSchema>), res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers can use this endpoint" });
      }

      if (isRestrictedUser(req) && !isAdmin(req)) {
        return restrictedResponse(res, {
          message: "Your account is temporarily restricted. Please try again later or contact support.",
          restrictedUntil: req.user.restrictedUntil ?? null,
        });
      }

      const { title, description, location } = req.validated.body;

      const classification = await classifyJob(`${title}\n${description}`);
      const suggestion = suggestJobPrice({
        category: classification.category,
        trade: classification.trade,
        location: location ?? null,
        title,
        description,
      });

      return res.json({
        classification,
        suggestion,
      });
    } catch (err) {
      console.error("POST /jobs/suggest-price error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while suggesting a price range." });
    }
  }
);

app.post(
  "/jobs",
  authMiddleware,
  requireVerifiedEmail,
  jobCreateLimiter,
  validate(createJobSchema),
  async (req: (AuthRequest & ValidatedRequest<typeof createJobSchema>), res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can create jobs" });
    }

    if (isRestrictedUser(req) && !isAdmin(req)) {
      return restrictedResponse(res, {
        message: "Your account is temporarily restricted from posting jobs. Please try again later.",
        restrictedUntil: req.user.restrictedUntil ?? null,
      });
    }

    const { title, description, budgetMin, budgetMax, location } = req.validated.body;

    const classification = await classifyJob(`${title}\n${description}`);
    const suggestion = suggestJobPrice({
      category: classification.category,
      trade: classification.trade,
      location: location ?? null,
      title,
      description,
    });

    // Risk scoring (best-effort; does not fail the request if DB is missing new columns)
    const risk = await assessJobPostRisk({
      consumerId: req.user.userId,
      title,
      description,
      location: location ?? null,
    });

    let job: any;
    try {
      job = await prisma.job.create({
        data: {
          title,
          description,
          budgetMin: budgetMin ?? null,
          budgetMax: budgetMax ?? null,
          location: location ?? null,
          consumerId: req.user.userId,
          status: "OPEN",
          category: classification.category,
          trade: classification.trade,
          urgency: classification.urgency,
          suggestedTags: classification.suggestedTags,
          suggestedMinPrice: suggestion.suggestedMinPrice,
          suggestedMaxPrice: suggestion.suggestedMaxPrice,
          suggestedReason: suggestion.suggestedReason,
          riskScore: risk.totalScore,
        },
      });
    } catch (err: any) {
      // Deploy-safe fallback if DB migration lags API deploy.
      if (!isMissingDbColumnError(err)) throw err;
      job = await prisma.job.create({
        data: {
          title,
          description,
          budgetMin: budgetMin ?? null,
          budgetMax: budgetMax ?? null,
          location: location ?? null,
          consumerId: req.user.userId,
          status: "OPEN",
        },
      });
    }

    let reviewRequired = false;
    let restrictedUntil: Date | null = null;
    try {
      if (risk.totalScore >= RISK_REVIEW_THRESHOLD) {
        reviewRequired = true;
        // Hide from public browse; consumer can still view their own.
        await prisma.job.update({
          where: { id: job.id },
          data: { isHidden: true, hiddenAt: new Date() },
        });
      }

      if (risk.totalScore >= RISK_RESTRICT_THRESHOLD) {
        restrictedUntil = computeRestrictedUntil();
        await prisma.user.update({
          where: { id: req.user.userId },
          data: {
            riskScore: { increment: risk.totalScore },
            restrictedUntil,
          },
        });
      } else if (risk.totalScore > 0) {
        await prisma.user.update({
          where: { id: req.user.userId },
          data: {
            riskScore: { increment: risk.totalScore },
          },
        });
      }
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      // If columns don't exist yet, ignore persistence.
    }

    // ✅ enqueue webhook
    await enqueueWebhookEvent({
      eventType: "job.created",
      payload: {
        jobId: job.id,
        consumerId: job.consumerId,
        title: job.title,
        location: job.location,
        status: job.status,
        budgetMin: job.budgetMin,
        budgetMax: job.budgetMax,
        category: job.category ?? classification.category,
        trade: job.trade ?? classification.trade,
        urgency: job.urgency ?? classification.urgency,
        suggestedTags: job.suggestedTags ?? classification.suggestedTags,
        createdAt: job.createdAt,
      },
    });

    // ✅ enqueue smart-match notifications (dedicated worker service)
    if (!reviewRequired) {
      await enqueueBackgroundJob({
        type: "JOB_MATCH_NOTIFY",
        payload: { jobId: job.id },
      });
    }

    return res.status(reviewRequired ? 202 : 201).json({
      id: job.id,
      title: job.title,
      description: job.description,
      budgetMin: job.budgetMin,
      budgetMax: job.budgetMax,
      location: job.location,
      status: job.status,
      category: job.category ?? classification.category,
      trade: job.trade ?? classification.trade,
      urgency: job.urgency ?? classification.urgency,
      suggestedTags: job.suggestedTags ?? classification.suggestedTags,
      suggestedMinPrice: job.suggestedMinPrice ?? suggestion.suggestedMinPrice,
      suggestedMaxPrice: job.suggestedMaxPrice ?? suggestion.suggestedMaxPrice,
      suggestedReason: job.suggestedReason ?? suggestion.suggestedReason,
      reviewRequired,
      restrictedUntil,
      createdAt: job.createdAt,
    });
  } catch (err) {
    console.error("Create job error:", err);
    return res.status(500).json({ error: "Internal server error while creating job." });
  }
});


// GET /jobs/browse
// Query params:
//   q?: string
//   location?: string
//   cursor?: number (jobId)
//   limit?: number (default 20, max 50)
app.get("/jobs/browse", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { q, location, cursor, limit } = req.query as {
      q?: string;
      location?: string;
      cursor?: string;
      limit?: string;
    };

    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const take = parsePositiveInt(limit, 20, 50);
    const cursorId = parseOptionalCursorId(cursor);

    const { jobWhereVisible } = visibilityFilters(req);

    const where: any = {
      status: "OPEN",
      ...jobWhereVisible, // keep your query-level visibility rules
    };

    if (q && q.trim()) {
      where.OR = [
        { title: { contains: q.trim(), mode: "insensitive" } },
        { description: { contains: q.trim(), mode: "insensitive" } },
      ];
    }

    if (location && location.trim()) {
      where.location = { contains: location.trim(), mode: "insensitive" };
    }

    const selectBase = {
      id: true,
      title: true,
      description: true,
      budgetMin: true,
      budgetMax: true,
      status: true,
      location: true,
      createdAt: true,
      consumer: { select: { id: true, name: true, location: true, isSuspended: true } },
      _count: { select: { bids: true } },
      attachments: true,
    } as const;

    const selectWithClassification = {
      ...selectBase,
      category: true,
      trade: true,
      urgency: true,
      suggestedTags: true,
    } as const;

    let jobs: any[] = [];
    let hasClassificationColumns = true;
    try {
      jobs = await prisma.job.findMany({
        where,
        orderBy: [{ id: "desc" }],
        take,
        ...(cursorId
          ? {
              cursor: { id: cursorId },
              skip: 1,
            }
          : {}),
        select: selectWithClassification,
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      hasClassificationColumns = false;
      jobs = await prisma.job.findMany({
        where,
        orderBy: [{ id: "desc" }],
        take,
        ...(cursorId
          ? {
              cursor: { id: cursorId },
              skip: 1,
            }
          : {}),
        select: selectBase,
      });
    }

    // Optional favorites block (keep if you have favoriteJob)
    let favoriteJobIds = new Set<number>();
    if (jobs.length > 0) {
      const jobIds = jobs.map((j) => j.id);
      const favs = await prisma.favoriteJob.findMany({
        where: { userId: req.user.userId, jobId: { in: jobIds } },
        select: { jobId: true },
      });
      favoriteJobIds = new Set(favs.map((f) => f.jobId));
    }

    const nextCursor = jobs.length === take ? jobs[jobs.length - 1].id : null;

    const items = hasClassificationColumns
      ? jobs.map((j) => ({
          id: j.id,
          title: j.title,
          description: j.description,
          budgetMin: j.budgetMin,
          budgetMax: j.budgetMax,
          status: j.status,
          location: j.location,
          category: j.category,
          trade: j.trade,
          urgency: j.urgency,
          suggestedTags: j.suggestedTags ?? [],
          createdAt: j.createdAt,
          bidCount: j._count.bids,
          isFavorited: favoriteJobIds.has(j.id),
          consumer: {
            id: j.consumer.id,
            name: j.consumer.name,
            location: j.consumer.location,
          },
          attachments: (j.attachments ?? []).map((a: any) => ({
            ...a,
            url: attachmentPublicUrl(req, a.id),
          })),
        }))
      : await Promise.all(
          jobs.map(async (j) => {
            const cls = await classifyJob(`${j.title}\n${j.description ?? ""}`);
            return {
              id: j.id,
              title: j.title,
              description: j.description,
              budgetMin: j.budgetMin,
              budgetMax: j.budgetMax,
              status: j.status,
              location: j.location,
              category: cls.category,
              trade: cls.trade,
              urgency: cls.urgency,
              suggestedTags: cls.suggestedTags,
              createdAt: j.createdAt,
              bidCount: j._count.bids,
              isFavorited: favoriteJobIds.has(j.id),
              consumer: {
                id: j.consumer.id,
                name: j.consumer.name,
                location: j.consumer.location,
              },
              attachments: (j.attachments ?? []).map((a: any) => ({
                ...a,
                url: attachmentPublicUrl(req, a.id),
              })),
            };
          })
        );

    return res.json({
      items,
      pageInfo: {
        limit: take,
        nextCursor,
      },
    });
  } catch (err) {
    console.error("GET /jobs/browse error:", err);
    return res.status(500).json({ error: "Internal server error while browsing jobs." });
  }
});


// POST /jobs/:jobId/attachments
// Body: { url: string, type?: string }
app.post(
  "/jobs/:jobId/attachments",
  authMiddleware,
  validate({
    params: jobIdParamsSchema,
    body: z.object({
      url: z.string().trim().min(1, "url is required"),
      type: z.string().trim().optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { jobId } = (req as any).validated.params as { jobId: number };
    const { url, type } = (req as any).validated.body as { url: string; type?: string };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        consumerId: true,
        status: true,
        title: true,
        location: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Only consumer who created the job can add attachments
    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({
        error: "You may only add attachments to jobs you created.",
      });
    }

    const attach = await prisma.jobAttachment.create({
      data: {
        jobId,
        url: url.trim(),
        uploaderUserId: req.user.userId,
        type: type?.trim() || null,
      },
    });

    // ✅ Webhook: attachment added
    await enqueueWebhookEvent({
      eventType: "job.attachment_added",
      payload: {
        attachmentId: attach.id,
        jobId: attach.jobId,
        addedByUserId: req.user.userId,
        url: attach.url,
        type: attach.type,
        createdAt: attach.createdAt,
        job: {
          title: job.title,
          status: job.status,
          location: job.location,
        },
      },
    });

    return res.json({
      message: "Attachment added.",
      attachment: attach,
    });
  } catch (err) {
    console.error("POST /jobs/:jobId/attachments error:", err);
    return res.status(500).json({
      error: "Internal server error while adding attachment.",
    });
  }
});

// POST /jobs/:jobId/attachments/upload
// Multipart: file=<binary>
app.post(
  "/jobs/:jobId/attachments/upload",
  authMiddleware,
  validate({ params: jobIdParamsSchema }),
  uploadSingleAttachment,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const { jobId } = (req as any).validated.params as { jobId: number };

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: "file is required" });
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true, status: true, title: true, location: true },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (job.consumerId !== req.user.userId) {
        return res.status(403).json({
          error: "You may only add attachments to jobs you created.",
        });
      }

      const publicBase =
        (process.env.PUBLIC_BASE_URL ?? "").trim() ||
        `${req.protocol}://${req.get("host")}`;

      const kind = file.mimetype.startsWith("video/") ? "video" : "image";
      const basename = makeUploadBasename(file.originalname);
      const { storageKey, diskPath } = computeNewUploadTargets({
        namespace: "job",
        ownerId: jobId,
        basename,
        storageProvider: attachmentStorageProvider,
      });

      let cleanupOnDbFailure: null | (() => Promise<void>) = null;
      if (attachmentStorageProvider && storageKey) {
        await attachmentStorageProvider.putObject(storageKey, file.buffer, file.mimetype);
        cleanupOnDbFailure = async () => {
          await attachmentStorageProvider.deleteObject(storageKey).catch(() => null);
        };
      } else if (diskPath) {
        const abs = path.join(UPLOADS_DIR, diskPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, file.buffer);
        cleanupOnDbFailure = async () => {
          await fs.promises.unlink(abs).catch(() => null);
        };
      }

      let attach: any;
      try {
        attach = await prisma.$transaction(async (tx) => {
          const created = await tx.jobAttachment.create({
            data: {
              jobId,
              url: "",
              diskPath,
              storageKey,
              uploaderUserId: req.user!.userId,
              type: kind,
              mimeType: file.mimetype,
              filename: file.originalname || null,
              sizeBytes: file.size || null,
            },
          });

          const url = `${publicBase}/attachments/${created.id}`;
          return tx.jobAttachment.update({
            where: { id: created.id },
            data: { url },
          });
        });
      } catch (e) {
        await cleanupOnDbFailure?.();
        throw e;
      }

      await enqueueWebhookEvent({
        eventType: "job.attachment_added",
        payload: {
          attachmentId: attach.id,
          jobId: attach.jobId,
          addedByUserId: req.user.userId,
          url: `${publicBase}/attachments/${attach.id}`,
          type: attach.type,
          mimeType: attach.mimeType,
          filename: attach.filename,
          sizeBytes: attach.sizeBytes,
          createdAt: attach.createdAt,
          job: {
            title: job.title,
            status: job.status,
            location: job.location,
          },
        },
      });

      return res.status(201).json({
        message: "Attachment uploaded.",
        attachment: {
          ...attach,
          url: `${publicBase}/attachments/${attach.id}`,
        },
        limits: { maxBytes: MAX_ATTACHMENT_BYTES },
      });
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("File too large")) {
        return res.status(413).json({
          error: `Attachment exceeds size limit (${MAX_ATTACHMENT_BYTES} bytes).`,
        });
      }
      if (msg.includes("Unsupported file type")) {
        return res.status(415).json({ error: msg });
      }
      console.error("POST /jobs/:jobId/attachments/upload error:", err);
      return res.status(500).json({
        error: "Internal server error while uploading attachment.",
      });
    }
  }
);

// --- Bids: place/update bid on a job (PROVIDER only) ---
// POST /jobs/:jobId/bids
// Body: { amount, message? }
// Notes:
// - If provider already has a bid, this acts like "update my bid".
// - Updates are blocked if bid is locked (non-PENDING or counter already ACCEPTED).

const placeBidSchema = {
  params: z.object({
    jobId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      templateId: z.coerce.number().int().positive().optional(),
      amount: z.coerce.number().finite().positive().optional(),
      message: z.string().trim().max(2000).optional(),
    })
    .superRefine((val, ctx) => {
      // Backwards compatible: if no templateId, amount is required.
      if (!val.templateId && typeof val.amount !== "number") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amount"],
          message: "Amount is required when no templateId is provided.",
        });
      }
    }),
};

const bidTemplateCreateSchema = {
  body: z.object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2000),
    defaultAmount: z.coerce.number().finite().positive().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  }),
};

const bidTemplateUpdateSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      body: z.string().trim().min(1).max(2000).optional(),
      defaultAmount: z.coerce.number().finite().positive().nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    })
    .superRefine((val, ctx) => {
      const hasAny =
        typeof val.title === "string" ||
        typeof val.body === "string" ||
        typeof val.defaultAmount !== "undefined" ||
        typeof val.tags !== "undefined";
      if (!hasAny) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide at least one field to update.",
        });
      }
    }),
};

const bidTemplateIdParamSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
};

const quickReplyCreateSchema = {
  body: z.object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(2000),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  }),
};

const quickReplyUpdateSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      title: z.string().trim().min(1).max(80).optional(),
      body: z.string().trim().min(1).max(2000).optional(),
      tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    })
    .superRefine((val, ctx) => {
      const hasAny =
        typeof val.title === "string" || typeof val.body === "string" || typeof val.tags !== "undefined";
      if (!hasAny) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one field to update." });
      }
    }),
};

const quickReplyIdParamSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
};

const zip5Schema = z
  .string()
  .trim()
  .regex(/^\d{5}$/, "Expected a 5-digit ZIP code");

const providerSavedSearchCreateSchema = {
  body: z
    .object({
      categories: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
      radiusMiles: z.coerce.number().int().min(1).max(500),
      zipCode: zip5Schema,
      minBudget: z.coerce.number().int().positive().nullable().optional(),
      maxBudget: z.coerce.number().int().positive().nullable().optional(),
      isEnabled: z.coerce.boolean().optional(),
    })
    .superRefine((val, ctx) => {
      const minB = val.minBudget == null ? null : Number(val.minBudget);
      const maxB = val.maxBudget == null ? null : Number(val.maxBudget);
      if (minB != null && maxB != null && minB > maxB) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "minBudget must be <= maxBudget",
        });
      }
    }),
};

const providerSavedSearchUpdateSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      categories: z.array(z.string().trim().min(1).max(64)).min(1).max(20).optional(),
      radiusMiles: z.coerce.number().int().min(1).max(500).optional(),
      zipCode: zip5Schema.optional(),
      minBudget: z.coerce.number().int().positive().nullable().optional(),
      maxBudget: z.coerce.number().int().positive().nullable().optional(),
      isEnabled: z.coerce.boolean().optional(),
    })
    .superRefine((val, ctx) => {
      const hasAny =
        typeof val.categories !== "undefined" ||
        typeof val.radiusMiles !== "undefined" ||
        typeof val.zipCode !== "undefined" ||
        typeof val.minBudget !== "undefined" ||
        typeof val.maxBudget !== "undefined" ||
        typeof val.isEnabled !== "undefined";

      if (!hasAny) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide at least one field to update.",
        });
      }

      const minB = typeof val.minBudget === "undefined" || val.minBudget == null ? null : Number(val.minBudget);
      const maxB = typeof val.maxBudget === "undefined" || val.maxBudget == null ? null : Number(val.maxBudget);
      if (minB != null && maxB != null && minB > maxB) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "minBudget must be <= maxBudget",
        });
      }
    }),
};

const providerSavedSearchIdParamSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
};

const hhmmSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected time in HH:MM (24h) format");

const providerAvailabilityReplaceSchema = {
  body: z
    .object({
      timezone: z.string().trim().min(1).max(64),
      slots: z
        .array(
          z.object({
            dayOfWeek: z.coerce.number().int().min(0).max(6),
            startTime: hhmmSchema,
            endTime: hhmmSchema,
          })
        )
        .max(70)
        .default([]),
    })
    .superRefine((val, ctx) => {
      for (let i = 0; i < val.slots.length; i++) {
        const slot = val.slots[i];
        const [sh, sm] = slot.startTime.split(":").map((n) => Number(n));
        const [eh, em] = slot.endTime.split(":").map((n) => Number(n));
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        if (!(endMin > startMin)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["slots", i, "endTime"],
            message: "endTime must be after startTime.",
          });
        }
      }
    }),
};

const jobIdParamSchema = {
  params: z.object({
    jobId: z.coerce.number().int().positive(),
  }),
};

const appointmentProposeSchema = {
  params: z.object({
    jobId: z.coerce.number().int().positive(),
  }),
  body: z
    .object({
      startAt: z.string().datetime(),
      endAt: z.string().datetime(),
    })
    .superRefine((val, ctx) => {
      const start = new Date(val.startAt);
      const end = new Date(val.endAt);
      if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startAt"], message: "Invalid startAt" });
        return;
      }
      if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Invalid endAt" });
        return;
      }
      if (!(end.getTime() > start.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endAt"],
          message: "endAt must be after startAt.",
        });
      }
    }),
};

const appointmentIdParamSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
};

const appointmentCalendarEventSchema = {
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    eventId: z.string().trim().min(1).max(200),
  }),
};

const appointmentSelectBase = {
  id: true,
  jobId: true,
  providerId: true,
  consumerId: true,
  startAt: true,
  endAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const appointmentSelectWithCalendar = {
  ...appointmentSelectBase,
  calendarEventId: true,
} as const;

function isMissingDbColumnError(err: any): boolean {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  // Prisma uses P2022 for missing columns in some engines/adapters.
  if (code === "P2022") return true;
  return /column/i.test(msg) && /does not exist/i.test(msg);
}

const WEEKDAY_SHORT_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getLocalDayOfWeekAndMinutes(date: Date, timeZone: string): { dayOfWeek: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hourStr = parts.find((p) => p.type === "hour")?.value;
  const minuteStr = parts.find((p) => p.type === "minute")?.value;

  const dayOfWeek = weekday ? WEEKDAY_SHORT_TO_DOW[weekday] : undefined;
  const hour = hourStr ? Number(hourStr) : NaN;
  const minute = minuteStr ? Number(minuteStr) : NaN;

  if (typeof dayOfWeek !== "number" || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error("Failed to compute local time parts");
  }

  return { dayOfWeek, minutes: hour * 60 + minute };
}

function parseHHMMToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  return h * 60 + m;
}

async function assertProviderAvailableAndNoConflicts(opts: {
  providerId: number;
  startAt: Date;
  endAt: Date;
  excludeAppointmentId?: number;
}) {
  const availabilities = await prisma.providerAvailability.findMany({
    where: { providerId: opts.providerId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
  });

  if (availabilities.length === 0) {
    throw new Error("Provider has not set availability.");
  }

  const timezones = Array.from(new Set(availabilities.map((a) => a.timezone)));
  if (timezones.length !== 1) {
    throw new Error("Provider availability timezone is not configured consistently.");
  }
  const timeZone = timezones[0];

  const localStart = getLocalDayOfWeekAndMinutes(opts.startAt, timeZone);
  const localEnd = getLocalDayOfWeekAndMinutes(opts.endAt, timeZone);

  if (localStart.dayOfWeek !== localEnd.dayOfWeek) {
    throw new Error("Appointment must start and end on the same local day for the provider.");
  }

  const matching = availabilities.filter((a) => a.dayOfWeek === localStart.dayOfWeek);
  const within = matching.some((a) => {
    const aStart = parseHHMMToMinutes(a.startTime);
    const aEnd = parseHHMMToMinutes(a.endTime);
    return aStart <= localStart.minutes && aEnd >= localEnd.minutes;
  });

  if (!within) {
    throw new Error("Requested time is outside provider availability.");
  }

  const conflict = await prisma.appointment.findFirst({
    where: {
      providerId: opts.providerId,
      status: "CONFIRMED",
      ...(typeof opts.excludeAppointmentId === "number" ? { id: { not: opts.excludeAppointmentId } } : {}),
      AND: [{ startAt: { lt: opts.endAt } }, { endAt: { gt: opts.startAt } }],
    },
    select: { id: true, startAt: true, endAt: true },
  });
  if (conflict) {
    throw new Error("Provider has a conflicting confirmed appointment.");
  }
}

// --- Provider quick replies (CRUD) ---
// GET /provider/quick-replies
app.get(
  "/provider/quick-replies",
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage quick replies" });
      }

      const items = await prisma.providerQuickReply.findMany({
        where: { providerId: req.user.userId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });

      return res.json({ items });
    } catch (err) {
      console.error("GET /provider/quick-replies error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /provider/quick-replies
app.post(
  "/provider/quick-replies",
  authMiddleware,
  requireVerifiedEmail,
  validate(quickReplyCreateSchema),
  async (req: AuthRequest & { validated: Validated<typeof quickReplyCreateSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage quick replies" });
      }

      const created = await prisma.providerQuickReply.create({
        data: {
          providerId: req.user.userId,
          title: req.validated.body.title.trim(),
          body: req.validated.body.body.trim(),
          tags: (req.validated.body.tags ?? []).map((t) => t.trim()).filter(Boolean),
        },
      });

      return res.status(201).json({ item: created });
    } catch (err) {
      console.error("POST /provider/quick-replies error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// PUT /provider/quick-replies/:id
app.put(
  "/provider/quick-replies/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(quickReplyUpdateSchema),
  async (req: AuthRequest & { validated: Validated<typeof quickReplyUpdateSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage quick replies" });
      }

      const id = req.validated.params.id;
      const existing = await prisma.providerQuickReply.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Quick reply not found." });

      const updated = await prisma.providerQuickReply.update({
        where: { id },
        data: {
          title: typeof req.validated.body.title === "string" ? req.validated.body.title.trim() : undefined,
          body: typeof req.validated.body.body === "string" ? req.validated.body.body.trim() : undefined,
          tags:
            typeof req.validated.body.tags !== "undefined"
              ? req.validated.body.tags.map((t) => t.trim()).filter(Boolean)
              : undefined,
        },
      });

      return res.json({ item: updated });
    } catch (err) {
      console.error("PUT /provider/quick-replies/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// DELETE /provider/quick-replies/:id
app.delete(
  "/provider/quick-replies/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(quickReplyIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof quickReplyIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage quick replies" });
      }

      const id = req.validated.params.id;
      const existing = await prisma.providerQuickReply.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Quick reply not found." });

      await prisma.providerQuickReply.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /provider/quick-replies/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);


// --- Provider saved searches (CRUD) ---
// GET /provider/saved-searches
app.get(
  "/provider/saved-searches",
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage saved searches" });
      }

      const items = await prisma.providerSavedSearch.findMany({
        where: { providerId: req.user.userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });

      return res.json({ items });
    } catch (err) {
      console.error("GET /provider/saved-searches error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /provider/saved-searches
app.post(
  "/provider/saved-searches",
  authMiddleware,
  requireVerifiedEmail,
  validate(providerSavedSearchCreateSchema),
  async (
    req: AuthRequest & { validated: Validated<typeof providerSavedSearchCreateSchema> },
    res: Response
  ) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage saved searches" });
      }

      const maxSaved = Number(process.env.PROVIDER_SAVED_SEARCH_MAX ?? 10);
      const existingCount = await prisma.providerSavedSearch.count({
        where: { providerId: req.user.userId },
      });
      if (existingCount >= Math.max(1, Math.min(50, maxSaved))) {
        return res.status(400).json({ error: "Saved search limit reached." });
      }

      const body = req.validated.body;

      const created = await prisma.providerSavedSearch.create({
        data: {
          providerId: req.user.userId,
          categories: body.categories.map((c) => c.trim()).filter(Boolean),
          radiusMiles: body.radiusMiles,
          zipCode: body.zipCode.trim(),
          minBudget: body.minBudget ?? null,
          maxBudget: body.maxBudget ?? null,
          isEnabled: typeof body.isEnabled === "boolean" ? body.isEnabled : true,
        },
      });

      return res.status(201).json({ item: created });
    } catch (err) {
      console.error("POST /provider/saved-searches error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// PUT /provider/saved-searches/:id
app.put(
  "/provider/saved-searches/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(providerSavedSearchUpdateSchema),
  async (
    req: AuthRequest & { validated: Validated<typeof providerSavedSearchUpdateSchema> },
    res: Response
  ) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage saved searches" });
      }

      const id = req.validated.params.id;

      const existing = await prisma.providerSavedSearch.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Saved search not found." });

      const body = req.validated.body;

      const updated = await prisma.providerSavedSearch.update({
        where: { id },
        data: {
          categories:
            typeof body.categories !== "undefined"
              ? body.categories.map((c) => c.trim()).filter(Boolean)
              : undefined,
          radiusMiles: typeof body.radiusMiles !== "undefined" ? body.radiusMiles : undefined,
          zipCode: typeof body.zipCode === "string" ? body.zipCode.trim() : undefined,
          minBudget: typeof body.minBudget !== "undefined" ? body.minBudget : undefined,
          maxBudget: typeof body.maxBudget !== "undefined" ? body.maxBudget : undefined,
          isEnabled: typeof body.isEnabled === "boolean" ? body.isEnabled : undefined,
        },
      });

      return res.json({ item: updated });
    } catch (err) {
      console.error("PUT /provider/saved-searches/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// DELETE /provider/saved-searches/:id
app.delete(
  "/provider/saved-searches/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(providerSavedSearchIdParamSchema),
  async (
    req: AuthRequest & { validated: Validated<typeof providerSavedSearchIdParamSchema> },
    res: Response
  ) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage saved searches" });
      }

      const id = req.validated.params.id;
      const existing = await prisma.providerSavedSearch.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Saved search not found." });

      await prisma.providerSavedSearch.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /provider/saved-searches/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// --- Provider bid templates (CRUD) ---
// GET /provider/bid-templates
app.get(
  "/provider/bid-templates",
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage bid templates" });
      }

      const items = await prisma.bidTemplate.findMany({
        where: { providerId: req.user.userId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      });

      return res.json({ items });
    } catch (err) {
      console.error("GET /provider/bid-templates error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /provider/bid-templates
app.post(
  "/provider/bid-templates",
  authMiddleware,
  requireVerifiedEmail,
  validate(bidTemplateCreateSchema),
  async (req: AuthRequest & { validated: Validated<typeof bidTemplateCreateSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage bid templates" });
      }

      const created = await prisma.bidTemplate.create({
        data: {
          providerId: req.user.userId,
          title: req.validated.body.title.trim(),
          body: req.validated.body.body.trim(),
          defaultAmount:
            typeof req.validated.body.defaultAmount === "number"
              ? Math.trunc(req.validated.body.defaultAmount)
              : null,
          tags: (req.validated.body.tags ?? []).map((t) => t.trim()).filter(Boolean),
        },
      });

      return res.status(201).json({ item: created });
    } catch (err) {
      console.error("POST /provider/bid-templates error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// GET /provider/bid-templates/:id
app.get(
  "/provider/bid-templates/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(bidTemplateIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof bidTemplateIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage bid templates" });
      }

      const id = req.validated.params.id;
      const item = await prisma.bidTemplate.findFirst({
        where: { id, providerId: req.user.userId },
      });
      if (!item) return res.status(404).json({ error: "Bid template not found." });

      return res.json({ item });
    } catch (err) {
      console.error("GET /provider/bid-templates/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// PUT /provider/bid-templates/:id
app.put(
  "/provider/bid-templates/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(bidTemplateUpdateSchema),
  async (req: AuthRequest & { validated: Validated<typeof bidTemplateUpdateSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage bid templates" });
      }

      const id = req.validated.params.id;

      const existing = await prisma.bidTemplate.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Bid template not found." });

      const updated = await prisma.bidTemplate.update({
        where: { id },
        data: {
          title: typeof req.validated.body.title === "string" ? req.validated.body.title.trim() : undefined,
          body: typeof req.validated.body.body === "string" ? req.validated.body.body.trim() : undefined,
          defaultAmount:
            typeof req.validated.body.defaultAmount !== "undefined"
              ? req.validated.body.defaultAmount === null
                ? null
                : Math.trunc(req.validated.body.defaultAmount)
              : undefined,
          tags:
            typeof req.validated.body.tags !== "undefined"
              ? req.validated.body.tags.map((t) => t.trim()).filter(Boolean)
              : undefined,
        },
      });

      return res.json({ item: updated });
    } catch (err) {
      console.error("PUT /provider/bid-templates/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// DELETE /provider/bid-templates/:id
app.delete(
  "/provider/bid-templates/:id",
  authMiddleware,
  requireVerifiedEmail,
  validate(bidTemplateIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof bidTemplateIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage bid templates" });
      }

      const id = req.validated.params.id;
      const existing = await prisma.bidTemplate.findFirst({
        where: { id, providerId: req.user.userId },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Bid template not found." });

      await prisma.bidTemplate.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /provider/bid-templates/:id error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// --- Provider availability ---
// GET /provider/availability
app.get(
  "/provider/availability",
  authMiddleware,
  requireVerifiedEmail,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage availability" });
      }

      const slots = await prisma.providerAvailability.findMany({
        where: { providerId: req.user.userId },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });

      const timezone = slots.length > 0 ? slots[0].timezone : null;
      return res.json({ timezone, slots });
    } catch (err) {
      console.error("GET /provider/availability error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// PUT /provider/availability (replace)
app.put(
  "/provider/availability",
  authMiddleware,
  requireVerifiedEmail,
  validate(providerAvailabilityReplaceSchema),
  async (
    req: AuthRequest & { validated: Validated<typeof providerAvailabilityReplaceSchema> },
    res: Response
  ) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can manage availability" });
      }

      const { timezone, slots } = req.validated.body;

      await prisma.$transaction(async (tx) => {
        await tx.providerAvailability.deleteMany({ where: { providerId: req.user!.userId } });
        if (slots.length > 0) {
          await tx.providerAvailability.createMany({
            data: slots.map((s) => ({
              providerId: req.user!.userId,
              dayOfWeek: s.dayOfWeek,
              startTime: s.startTime,
              endTime: s.endTime,
              timezone,
            })),
          });
        }
      });

      const saved = await prisma.providerAvailability.findMany({
        where: { providerId: req.user.userId },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });

      return res.json({ timezone: saved.length > 0 ? saved[0].timezone : null, slots: saved });
    } catch (err) {
      console.error("PUT /provider/availability error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// --- Appointments ---
// GET /jobs/:jobId/appointments
app.get(
  "/jobs/:jobId/appointments",
  authMiddleware,
  validate(jobIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof jobIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const jobId = req.validated.params.jobId;
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true },
      });
      if (!job) return res.status(404).json({ error: "Job not found." });

      const awarded = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { providerId: true },
      });

      const isConsumer = req.user.userId === job.consumerId;
      const isProvider = typeof awarded?.providerId === "number" && req.user.userId === awarded.providerId;
      if (!isConsumer && !isProvider) {
        return res.status(403).json({ error: "Not authorized to view appointments for this job." });
      }

      try {
        const items = await prisma.appointment.findMany({
          where: { jobId },
          orderBy: [{ startAt: "asc" }, { id: "asc" }],
          select: appointmentSelectWithCalendar,
        });

        return res.json({ items });
      } catch (err: any) {
        // Allows deploying API code slightly ahead of the DB migration.
        if (!isMissingDbColumnError(err)) throw err;

        const items = await prisma.appointment.findMany({
          where: { jobId },
          orderBy: [{ startAt: "asc" }, { id: "asc" }],
          select: appointmentSelectBase,
        });

        return res.json({
          items: items.map((i) => ({ ...i, calendarEventId: null })),
          warnings: ["Appointment calendarEventId column not yet deployed"],
        });
      }
    } catch (err) {
      console.error("GET /jobs/:jobId/appointments error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /jobs/:jobId/appointments/propose (consumer)
app.post(
  "/jobs/:jobId/appointments/propose",
  authMiddleware,
  requireVerifiedEmail,
  validate(appointmentProposeSchema),
  async (req: AuthRequest & { validated: Validated<typeof appointmentProposeSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers can propose appointments" });
      }

      const jobId = req.validated.params.jobId;
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true, status: true },
      });
      if (!job) return res.status(404).json({ error: "Job not found." });
      if (job.consumerId !== req.user.userId) {
        return res.status(403).json({ error: "Not authorized for this job." });
      }
      if (job.status !== "AWARDED" && job.status !== "IN_PROGRESS") {
        return res.status(400).json({ error: "Appointments can be proposed once a provider is awarded." });
      }

      const awarded = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { providerId: true },
      });
      if (!awarded) {
        return res.status(400).json({ error: "No awarded provider for this job." });
      }

      const startAt = new Date(req.validated.body.startAt);
      const endAt = new Date(req.validated.body.endAt);

      try {
        await assertProviderAvailableAndNoConflicts({
          providerId: awarded.providerId,
          startAt,
          endAt,
        });
      } catch (e: any) {
        return res.status(400).json({ error: String(e?.message || "Invalid appointment time") });
      }

      const created = await prisma.appointment.create({
        data: {
          jobId,
          providerId: awarded.providerId,
          consumerId: req.user.userId,
          startAt,
          endAt,
          status: "PROPOSED",
        },
        select: appointmentSelectBase,
      });

      return res.status(201).json({ item: created });
    } catch (err) {
      console.error("POST /jobs/:jobId/appointments/propose error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /appointments/:id/confirm (provider)
app.post(
  "/appointments/:id/confirm",
  authMiddleware,
  requireVerifiedEmail,
  validate(appointmentIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof appointmentIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can confirm appointments" });
      }

      const id = req.validated.params.id;
      const appt = await prisma.appointment.findUnique({
        where: { id },
        select: { id: true, providerId: true, startAt: true, endAt: true, status: true, jobId: true },
      });
      if (!appt) return res.status(404).json({ error: "Appointment not found." });
      if (appt.providerId !== req.user.userId) {
        return res.status(403).json({ error: "Not authorized for this appointment." });
      }
      if (appt.status !== "PROPOSED") {
        return res.status(400).json({ error: "Only proposed appointments can be confirmed." });
      }

      const job = await prisma.job.findUnique({
        where: { id: appt.jobId },
        select: { id: true, status: true },
      });
      if (!job) return res.status(404).json({ error: "Job not found." });
      if (job.status !== "AWARDED" && job.status !== "IN_PROGRESS") {
        return res.status(400).json({ error: "Job is not awarded or in progress." });
      }

      try {
        await assertProviderAvailableAndNoConflicts({
          providerId: appt.providerId,
          startAt: appt.startAt,
          endAt: appt.endAt,
          excludeAppointmentId: appt.id,
        });
      } catch (e: any) {
        return res.status(400).json({ error: String(e?.message || "Invalid appointment time") });
      }

      const updated = await prisma.appointment.update({
        where: { id },
        data: { status: "CONFIRMED" },
        select: appointmentSelectBase,
      });

      return res.json({ item: updated });
    } catch (err) {
      console.error("POST /appointments/:id/confirm error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /appointments/:id/cancel (provider or consumer)
app.post(
  "/appointments/:id/cancel",
  authMiddleware,
  requireVerifiedEmail,
  validate(appointmentIdParamSchema),
  async (req: AuthRequest & { validated: Validated<typeof appointmentIdParamSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const id = req.validated.params.id;
      const appt = await prisma.appointment.findUnique({
        where: { id },
        select: { id: true, providerId: true, consumerId: true, status: true },
      });
      if (!appt) return res.status(404).json({ error: "Appointment not found." });

      const canCancel = req.user.userId === appt.providerId || req.user.userId === appt.consumerId;
      if (!canCancel) return res.status(403).json({ error: "Not authorized for this appointment." });
      if (appt.status === "CANCELLED") return res.json({ ok: true });

      const updated = await prisma.appointment.update({
        where: { id },
        data: { status: "CANCELLED" },
        select: appointmentSelectBase,
      });

      return res.json({ item: updated });
    } catch (err) {
      console.error("POST /appointments/:id/cancel error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

// POST /appointments/:id/calendar-event (provider)
app.post(
  "/appointments/:id/calendar-event",
  authMiddleware,
  requireVerifiedEmail,
  validate(appointmentCalendarEventSchema),
  async (
    req: AuthRequest & { validated: Validated<typeof appointmentCalendarEventSchema> },
    res: Response
  ) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can link calendar events" });
      }

      const id = req.validated.params.id;
      const { eventId } = req.validated.body;

      const appt = await prisma.appointment.findUnique({
        where: { id },
        select: { id: true, providerId: true, status: true },
      });
      if (!appt) return res.status(404).json({ error: "Appointment not found." });
      if (appt.providerId !== req.user.userId) {
        return res.status(403).json({ error: "Not authorized for this appointment." });
      }
      if (appt.status !== "CONFIRMED") {
        return res.status(400).json({ error: "Only confirmed appointments can be added to calendar." });
      }

      try {
        const updated = await prisma.appointment.update({
          where: { id },
          data: { calendarEventId: eventId },
          select: appointmentSelectWithCalendar,
        });

        return res.json({ item: updated });
      } catch (err: any) {
        if (isMissingDbColumnError(err)) {
          return res.status(501).json({
            error:
              "Calendar event persistence is not enabled on this server yet (missing DB column). Apply the prisma migration and redeploy.",
            code: "CALENDAR_PERSIST_NOT_ENABLED",
          });
        }
        throw err;
      }
    } catch (err) {
      console.error("POST /appointments/:id/calendar-event error:", err);
      return res.status(500).json({ error: "Internal server error." });
    }
  }
);

app.post(
  "/jobs/:jobId/bids",
  authMiddleware,
  requireVerifiedEmail,
  bidLimiter,
  validate(placeBidSchema),
  async (req: AuthRequest & { validated: Validated<typeof placeBidSchema> }, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can place bids" });
      }

      if (isRestrictedUser(req) && !isAdmin(req)) {
        return restrictedResponse(res, {
          message: "Your account is temporarily restricted from bidding. Please try again later.",
          restrictedUntil: req.user.restrictedUntil ?? null,
        });
      }

      const jobId = req.validated.params.jobId;
      const templateId = req.validated.body.templateId;

      let numericAmount = req.validated.body.amount;
      let message = req.validated.body.message;

      if (typeof templateId === "number") {
        const template = await prisma.bidTemplate.findFirst({
          where: { id: templateId, providerId: req.user.userId },
          select: { id: true, body: true, defaultAmount: true },
        });

        if (!template) {
          return res.status(404).json({ error: "Bid template not found." });
        }

        if (typeof numericAmount !== "number") {
          if (typeof template.defaultAmount === "number") {
            numericAmount = template.defaultAmount;
          } else {
            return res.status(400).json({
              error: "Amount is required because this template has no defaultAmount.",
            });
          }
        }

        if (typeof message !== "string" || message.trim().length === 0) {
          message = template.body;
        }
      }

      if (typeof numericAmount !== "number") {
        return res.status(400).json({ error: "Amount is required." });
      }

      // Bid.message is required in schema → always persist a string
      const messageText =
        typeof message === "string" && message.trim().length > 0 ? message.trim() : "";

      // Risk check for repeated/banned content in bid messages (best-effort)
      if (messageText) {
        try {
          const risk = await assessRepeatedBidMessageRisk({
            jobId,
            providerId: req.user.userId,
            messageText,
          });

          if (risk.signals.some((s) => s.code === "CONTACT_INFO") && !isAdmin(req)) {
            try {
              await prisma.user.update({
                where: { id: req.user.userId },
                data: { riskScore: { increment: risk.totalScore } },
              });
            } catch (e: any) {
              if (!isMissingDbColumnError(e)) throw e;
            }
            return res.status(400).json({
              error: "For your safety, sharing phone numbers or emails in bids is not allowed. Please use in-app messaging.",
              code: "CONTACT_INFO_NOT_ALLOWED",
            });
          }

          if (risk.totalScore >= RISK_RESTRICT_THRESHOLD && !isAdmin(req)) {
            const until = computeRestrictedUntil();
            try {
              await prisma.user.update({
                where: { id: req.user.userId },
                data: { riskScore: { increment: risk.totalScore }, restrictedUntil: until },
              });
            } catch (e: any) {
              if (!isMissingDbColumnError(e)) throw e;
            }
            return restrictedResponse(res, {
              message: "Your account is temporarily restricted due to suspicious activity.",
              restrictedUntil: until,
            });
          }

          if (risk.totalScore > 0) {
            try {
              await prisma.user.update({
                where: { id: req.user.userId },
                data: { riskScore: { increment: risk.totalScore } },
              });
            } catch (e: any) {
              if (!isMissingDbColumnError(e)) throw e;
            }
          }
        } catch (e) {
          // ignore scoring failures
        }
      }

      // IMPORTANT: include consumerId so we can notify the correct user
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, title: true, status: true, consumerId: true },
      });

      if (!job) return res.status(404).json({ error: "Job not found." });

      // Block check (existing behavior)
      const blocked = await isBlockedBetween(req.user.userId, job.consumerId);
      if (blocked) {
        return res.status(403).json({
          error: "You cannot place a bid on this job because one of you has blocked the other.",
        });
      }

      if (job.status !== "OPEN") {
        return res.status(400).json({
          error: `This job is not open for new bids. Current status: ${job.status}.`,
        });
      }

      // Find provider's most recent bid for this job (if any)
      const existing = await prisma.bid.findFirst({
        where: {
          jobId,
          providerId: req.user.userId,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          counter: {
            select: { status: true },
          },
        },
      });

      // ✅ If updating an existing bid, enforce "bid locked" rules
      if (existing) {
        if (existing.status !== "PENDING") {
          return res.status(400).json({
            error: `Bid cannot be edited because it is ${existing.status}.`,
          });
        }

        if (existing.counter && existing.counter.status === "ACCEPTED") {
          return res.status(400).json({
            error: "Bid cannot be edited because the counter offer was accepted.",
          });
        }
      }

      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        // Updating an existing bid does not consume capacity.
        if (existing) {
          const bid = await tx.bid.update({
            where: { id: existing.id },
            data: {
              amount: numericAmount,
              message: messageText,
            },
          });

          const sub = await ensureSubscriptionUsageIsCurrent(tx, req.user!.userId, now);
          const entitlements = getLeadEntitlementsFromSubscription(sub);

          return { kind: "updated" as const, bid, entitlements };
        }

        // New bid: consume one lead if available.
        const consumption = await consumeLeadIfAvailable(tx, req.user!.userId, now);
        if (!consumption.ok) {
          return { kind: "limit_reached" as const, entitlements: consumption.entitlements };
        }

        const bid = await tx.bid.create({
          data: {
            amount: numericAmount,
            message: messageText,
            jobId,
            providerId: req.user!.userId,
          },
        });

        return { kind: "created" as const, bid, entitlements: consumption.entitlements };
      });

      if (result.kind === "limit_reached") {
        return res.status(402).json({
          error: "Upgrade required",
          code: "LIMIT_REACHED",
          tier: result.entitlements.tier,
          usageMonthKey: result.entitlements.usageMonthKey,
          baseLeadLimitThisMonth: result.entitlements.baseLeadLimitThisMonth,
          extraLeadCreditsThisMonth: result.entitlements.extraLeadCreditsThisMonth,
          leadsUsedThisMonth: result.entitlements.leadsUsedThisMonth,
          remainingLeadsThisMonth: result.entitlements.remainingLeadsThisMonth,
        });
      }

      const bid = result.bid;
      const tier = result.entitlements.tier;

      // 🔔 Notify the job owner (consumer)
      {
        const now = new Date();
        const prefMap = await getNotificationPreferencesMap({
          prisma: prisma as any,
          userIds: [job.consumerId],
        });
        if (shouldSendNotification(prefMap.get(job.consumerId), "BID", now)) {
          await createNotification({
            userId: job.consumerId,
            type: "NEW_BID",
            content: {
              title: "New bid",
              body: `New bid (#${bid.id}) on your job "${job.title}".`,
              jobId: job.id,
              bidId: bid.id,
            },
          });
        }
      }

      // ✅ Webhook: bid placed (you can later split into bid.updated vs bid.placed)
      await enqueueWebhookEvent({
        eventType: "bid.placed",
        payload: {
          bidId: bid.id,
          jobId: bid.jobId,
          providerId: bid.providerId,
          consumerId: job.consumerId,
          amount: bid.amount,
          message: bid.message,
          createdAt: bid.createdAt,
          jobTitle: job.title,
          jobStatus: job.status,
          providerTier: tier,
        },
      });

      return res.status(existing ? 200 : 201).json({
        id: bid.id,
        amount: bid.amount,
        message: bid.message,
        jobId: bid.jobId,
        providerId: bid.providerId,
        createdAt: bid.createdAt,
      });
    } catch (err) {
      console.error("Place bid error:", err);
      return res.status(500).json({ error: "Internal server error while placing bid." });
    }
  }
);


// GET /jobs/:jobId/bids → consumer sees all bids on their job
app.get(
  "/jobs/:jobId/bids",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) {
        return res.status(400).json({ error: "Invalid job id" });
      }

      // Ensure job exists and belongs to this consumer
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          title: true,
          status: true,
          consumerId: true,
          // ✅ Optional, if your schema has it and you want job-level visibility:
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      const isOwnerConsumer =
        req.user.role === "CONSUMER" && job.consumerId === req.user.userId;

      if (!isOwnerConsumer && !isAdmin(req)) {
        return res.status(403).json({
          error: "You can only view bids for jobs you created.",
        });
      }


      // ✅ (Optional but recommended) enforce job visibility even for owner? up to you.
      // Most apps let owners see their own hidden jobs, so we usually do NOT block here.
      // If you DO want to block owners from hidden jobs too (rare), uncomment:
      //
      // if (!isAdmin(req)) {
      //   if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      //   if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
      // }

      const { userWhereVisible } = visibilityFilters(req);

      // Fetch bids, filtering out suspended providers for non-admin
      const bids = await prisma.bid.findMany({
        where: {
          jobId,
          provider: {
            ...userWhereVisible,
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          provider: { include: { providerProfile: true } },
          counter: true, // ✅ add this (requires your CounterOffer relation)
        },
      });


      // Is this job favorited by the current user?
      // (Owner is consumer, but leaving generic is fine)
      let jobIsFavorited = false;
      const fav = await prisma.favoriteJob.findUnique({
        where: {
          userId_jobId: {
            userId: req.user.userId,
            jobId,
          },
        },
      });
      jobIsFavorited = !!fav;

      return res.json(
        bids.map((b) => ({
          id: b.id,
          amount: b.amount,
          message: b.message,
          status: b.status,
          createdAt: b.createdAt,
          jobIsFavorited,
          provider: {
            id: b.provider.id,
            name: b.provider.name,
            location: b.provider.location,
            rating: b.provider.providerProfile?.rating ?? null,
            reviewCount: b.provider.providerProfile?.reviewCount ?? 0,
          },
          counter: b.counter
          ? {
              id: b.counter.id,
              minAmount: b.counter.minAmount,
              maxAmount: b.counter.maxAmount,
              amount: b.counter.amount,
              message: b.counter.message,
              status: b.counter.status,
              createdAt: b.counter.createdAt,
            }
          : null,

        }))
      );
    } catch (err) {
      console.error("GET /jobs/:jobId/bids error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching bids.",
      });
    }
  }
);

app.post(
  "/bids/:bidId/counter",
  authMiddleware,
  validate({
    params: bidIdParamsSchema,
    body: z.object({
      amount: z.coerce.number().optional(),
      minAmount: z.coerce.number().optional(),
      maxAmount: z.coerce.number().optional(),
      message: z.string().optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers can counter bids." });
      }

      const { bidId } = (req as any).validated.params as { bidId: number };

      const bid = await prisma.bid.findUnique({
        where: { id: bidId },
        include: {
          counter: true, // ✅ needed for "already accepted" guard
          job: { select: { id: true, consumerId: true, status: true, title: true } },
        },
      });

      if (!bid) return res.status(404).json({ error: "Bid not found." });

      // Must own the job
      if (bid.job.consumerId !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this job." });
      }

      // Job must be open
      if (bid.job.status !== "OPEN") {
        return res.status(400).json({
          error: `Job is not open. Current status: ${bid.job.status}.`,
        });
      }

      // Optional: block changing counter after accepted
      if (bid.counter && bid.counter.status === "ACCEPTED") {
        return res.status(400).json({
          error: "Counter was already accepted and cannot be changed.",
        });
      }

      // Only counter pending bids (recommended)
      if (bid.status !== "PENDING") {
        return res.status(400).json({
          error: `Cannot counter a bid that is not pending. Current bid status: ${bid.status}.`,
        });
      }

      const { amount, minAmount, maxAmount, message } = (req as any).validated.body as {
        amount?: number;
        minAmount?: number;
        maxAmount?: number;
        message?: string;
      };

      const messageText = typeof message === "string" ? message.trim() : "";

      // ---- Validate exact vs range ----
      let canonicalAmount: number;
      let min: number | null = null;
      let max: number | null = null;

      const hasRange = minAmount != null || maxAmount != null;

      if (hasRange) {
        const mn = Number(minAmount);
        const mx = Number(maxAmount);

        if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
          return res.status(400).json({ error: "minAmount and maxAmount must be numbers." });
        }
        if (mn <= 0 || mx <= 0) {
          return res.status(400).json({ error: "minAmount/maxAmount must be positive." });
        }
        if (mn >= mx) {
          return res.status(400).json({ error: "minAmount must be less than maxAmount." });
        }

        min = Math.round(mn);
        max = Math.round(mx);
        canonicalAmount = max; // canonical = max for range
      } else {
        const a = Number(amount);

        if (amount == null || !Number.isFinite(a) || a <= 0) {
          return res.status(400).json({ error: "amount must be a positive number." });
        }

        canonicalAmount = Math.round(a);
      }

      // Upsert counter (one per bid)
      const counter = await prisma.counterOffer.upsert({
        where: { bidId: bid.id },
        create: {
          bidId: bid.id,
          minAmount: min,
          maxAmount: max,
          amount: canonicalAmount,
          message: messageText,
          status: "PENDING",
        },
        update: {
          minAmount: min,
          maxAmount: max,
          amount: canonicalAmount,
          message: messageText,
          status: "PENDING", // reset pending on edit
        },
      });

      return res.status(201).json({
        counter: {
          id: counter.id,
          bidId: counter.bidId,
          minAmount: counter.minAmount,
          maxAmount: counter.maxAmount,
          amount: counter.amount,
          message: counter.message,
          status: counter.status,
          createdAt: counter.createdAt,
          updatedAt: counter.updatedAt,
        },
      });
    } catch (err) {
      console.error("POST /bids/:bidId/counter error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while countering bid." });
    }
  }
);

app.post(
  "/bids/:bidId/counter/accept",
  authMiddleware,
  validate({ params: bidIdParamsSchema }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can accept counters." });
      }

      const { bidId } = (req as any).validated.params as { bidId: number };

      const bid = await prisma.bid.findUnique({
        where: { id: bidId },
        include: {
          counter: true,
          job: { select: { id: true, status: true, title: true, consumerId: true } },
        },
      });

      if (!bid) return res.status(404).json({ error: "Bid not found." });
      if (bid.providerId !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this bid." });
      }

      if (bid.job.status !== "OPEN") {
        return res.status(400).json({
          error: `Job is not open. Current status: ${bid.job.status}.`,
        });
      }

      if (!bid.counter) {
        return res.status(404).json({ error: "No counter offer exists for this bid." });
      }

      if (bid.counter.status !== "PENDING") {
        return res.status(400).json({
          error: `Counter is not pending. Current status: ${bid.counter.status}.`,
        });
      }

      // Optional: prevent accepting a non-pending bid
      if (bid.status !== "PENDING") {
        return res.status(400).json({
          error: `Cannot accept counter for a bid that is not pending. Current bid status: ${bid.status}.`,
        });
      }

      const rangeText =
        bid.counter.minAmount != null && bid.counter.maxAmount != null
          ? `Counter accepted: $${bid.counter.minAmount}-${bid.counter.maxAmount}`
          : `Counter accepted: $${bid.counter.amount}`;

      const updated = await prisma.$transaction(async (tx) => {
        await tx.counterOffer.update({
          where: { bidId: bid.id },
          data: { status: "ACCEPTED" },
        });

        const newMessage =
          (bid.message?.trim() ? `${bid.message.trim()}\n` : "") + rangeText;

        const updatedBid = await tx.bid.update({
          where: { id: bid.id },
          data: {
            amount: bid.counter!.amount,
            message: newMessage,
            status: "ACCEPTED", // ✅ ensures provider side shows ACCEPTED
          },
          select: {
            id: true,
            jobId: true,
            providerId: true,
            amount: true,
            message: true,
            status: true,
            createdAt: true,
          },
        });

        // OPTIONAL: if you want counter acceptance to “lock in” immediately, you could:
        // - decline other bids on this job
        // - change job status
        // But many apps do that when the CONSUMER accepts a bid, not here.

        return updatedBid;
      });

      return res.json({ bid: updated });
    } catch (err) {
      console.error("POST /bids/:bidId/counter/accept error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while accepting counter." });
    }
  }
);

app.post(
  "/bids/:bidId/counter/decline",
  authMiddleware,
  validate({ params: bidIdParamsSchema }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can decline counters." });
      }

      const { bidId } = (req as any).validated.params as { bidId: number };

      const bid = await prisma.bid.findUnique({
        where: { id: bidId },
        include: {
          counter: true,
          job: { select: { id: true, status: true, title: true } },
        },
      });

      if (!bid) return res.status(404).json({ error: "Bid not found." });
      if (bid.providerId !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this bid." });
      }

      if (bid.job.status !== "OPEN") {
        return res.status(400).json({
          error: `Job is not open. Current status: ${bid.job.status}.`,
        });
      }

      if (!bid.counter) {
        return res.status(404).json({ error: "No counter offer exists for this bid." });
      }

      if (bid.counter.status !== "PENDING") {
        return res.status(400).json({
          error: `Counter is not pending. Current status: ${bid.counter.status}.`,
        });
      }

      const counter = await prisma.counterOffer.update({
        where: { bidId: bid.id },
        data: { status: "DECLINED" },
      });

      return res.json({
        counter: {
          id: counter.id,
          bidId: counter.bidId,
          minAmount: counter.minAmount,
          maxAmount: counter.maxAmount,
          amount: counter.amount,
          message: counter.message,
          status: counter.status,
          createdAt: counter.createdAt,
          updatedAt: counter.updatedAt,
        },
      });
    } catch (err) {
      console.error("POST /bids/:bidId/counter/decline error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while declining counter." });
    }
  }
);


// --- Consumer: My Jobs (with bid counts) ---
// GET /consumer/jobs
app.get("/consumer/jobs", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can view their jobs." });
    }

    const selectBase = {
      id: true,
      consumerId: true,
      title: true,
      description: true,
      status: true,
      location: true,
      createdAt: true,
      _count: { select: { bids: true } },
    } as const;

    const selectWithClassification = {
      ...selectBase,
      category: true,
      trade: true,
      urgency: true,
      suggestedTags: true,
      suggestedMinPrice: true,
      suggestedMaxPrice: true,
      suggestedReason: true,
    } as const;

    let jobs: any[] = [];
    let hasClassificationColumns = true;
    try {
      jobs = await prisma.job.findMany({
        where: { consumerId: req.user.userId },
        orderBy: { createdAt: "desc" },
        select: selectWithClassification,
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      hasClassificationColumns = false;
      jobs = await prisma.job.findMany({
        where: { consumerId: req.user.userId },
        orderBy: { createdAt: "desc" },
        select: selectBase,
      });
    }

    const items = hasClassificationColumns
      ? jobs.map((job) => ({
          id: job.id,
          title: job.title,
          status: job.status,
          location: job.location,
          createdAt: job.createdAt,
          bidCount: job._count.bids,
          category: job.category,
          trade: job.trade,
          urgency: job.urgency,
          suggestedTags: job.suggestedTags ?? [],
          suggestedMinPrice: job.suggestedMinPrice ?? null,
          suggestedMaxPrice: job.suggestedMaxPrice ?? null,
          suggestedReason: job.suggestedReason ?? null,
        }))
      : await Promise.all(
          jobs.map(async (job) => {
            const cls = await classifyJob(`${job.title}\n${job.description ?? ""}`);
            const suggestion = suggestJobPrice({
              category: cls.category,
              trade: cls.trade,
              location: job.location ?? null,
              title: job.title,
              description: job.description ?? "",
            });
            return {
              id: job.id,
              title: job.title,
              status: job.status,
              location: job.location,
              createdAt: job.createdAt,
              bidCount: job._count.bids,
              category: cls.category,
              trade: cls.trade,
              urgency: cls.urgency,
              suggestedTags: cls.suggestedTags,
              suggestedMinPrice: suggestion.suggestedMinPrice,
              suggestedMaxPrice: suggestion.suggestedMaxPrice,
              suggestedReason: suggestion.suggestedReason,
            };
          })
        );

    return res.json(items);
  } catch (err) {
    console.error("Consumer My Jobs error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching consumer jobs." });
  }
});


// --- Consumer: Job Details (for a single job the consumer owns) ---
// GET /consumer/jobs/:jobId
app.get("/consumer/jobs/:jobId", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can view this resource." });
    }

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId parameter" });

    let job: any;
    let cls: any | null = null;

    const selectBase = {
      id: true,
      consumerId: true,
      title: true,
      description: true,
      budgetMin: true,
      budgetMax: true,
      location: true,
      status: true,
      awardedAt: true,
      cancelledAt: true,
      cancelledByUserId: true,
      cancellationReasonCode: true,
      cancellationReasonDetails: true,
      completionPendingForUserId: true,
      completedAt: true,
      createdAt: true,
      _count: { select: { bids: true } },
      attachments: true,
      bids: {
        where: { status: "ACCEPTED" },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          provider: { include: { providerProfile: true } },
        },
      },
    } as const;

    const selectWithClassification = {
      ...selectBase,
      category: true,
      trade: true,
      urgency: true,
      suggestedTags: true,
      suggestedMinPrice: true,
      suggestedMaxPrice: true,
      suggestedReason: true,
    } as const;

    try {
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: selectWithClassification,
      });
      if (job) {
        cls = {
          category: job.category,
          trade: job.trade,
          urgency: job.urgency,
          suggestedTags: job.suggestedTags ?? [],
        };
      }
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: selectBase,
      });
    }

    if (!job) return res.status(404).json({ error: "Job not found." });

    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({ error: "You do not have permission to view this job." });
    }

    // ✅ FIX: actually read the included accepted bid
    const awarded = job.bids?.[0] ?? null;

    if (!cls) {
      cls = await classifyJob(`${job.title}\n${job.description ?? ""}`);
    }

    const suggestion = suggestJobPrice({
      category: cls.category,
      trade: cls.trade,
      location: job.location ?? null,
      title: job.title,
      description: job.description ?? "",
    });

    return res.json({
      id: job.id,
      title: job.title,
      description: job.description,
      budgetMin: job.budgetMin,
      budgetMax: job.budgetMax,
      location: job.location,
      status: job.status,
      awardedAt: (job as any).awardedAt ?? null,
      cancelledAt: (job as any).cancelledAt ?? null,
      cancelledByUserId: (job as any).cancelledByUserId ?? null,
      cancellationReasonCode: (job as any).cancellationReasonCode ?? null,
      cancellationReasonDetails: (job as any).cancellationReasonDetails ?? null,
      cancellationReasonLabel: cancellationReasonLabel((job as any).cancellationReasonCode ?? null),
      completionPendingForUserId: (job as any).completionPendingForUserId ?? null,
      completedAt: (job as any).completedAt ?? null,
      category: cls.category,
      trade: cls.trade,
      urgency: cls.urgency,
      suggestedTags: cls.suggestedTags ?? [],
      suggestedMinPrice: job.suggestedMinPrice ?? suggestion.suggestedMinPrice,
      suggestedMaxPrice: job.suggestedMaxPrice ?? suggestion.suggestedMaxPrice,
      suggestedReason: job.suggestedReason ?? suggestion.suggestedReason,
      createdAt: job.createdAt,
      bidCount: job._count.bids,
      attachments: job.attachments.map((a) => ({
        id: a.id,
        url: attachmentPublicUrl(req, a.id),
        type: a.type,
        createdAt: a.createdAt,
      })),

      awardedBid: awarded
        ? {
            id: awarded.id,
            amount: awarded.amount,
            message: awarded.message,
            createdAt: awarded.createdAt,
            provider: {
              id: awarded.provider.id,
              name: awarded.provider.name,
              location: awarded.provider.location,
              rating: awarded.provider.providerProfile?.rating ?? null,
              reviewCount: awarded.provider.providerProfile?.reviewCount ?? 0,
            },
          }
        : null,
    });
  } catch (err) {
    console.error("Consumer Job Details error:", err);
    return res.status(500).json({ error: "Internal server error while fetching job details." });
  }
});

// --- Provider: My Bids ---
// GET /provider/bids
app.get("/provider/bids", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can view their bids." });
    }

    const bids = await prisma.bid.findMany({
      where: { providerId: req.user.userId },
      orderBy: { createdAt: "desc" },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            location: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    return res.json(
      bids.map((b) => ({
        id: b.id,
        amount: b.amount,
        message: b.message,
        status: b.status,
        createdAt: b.createdAt,
        job: {
          id: b.job.id,
          title: b.job.title,
          location: b.job.location,
          status: b.job.status,
          createdAt: b.job.createdAt
        },
      }))
    );
  } catch (err) {
    console.error("Provider My Bids error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching provider bids." });
  }
});

// DEBUG: temporary endpoints to inspect provider data locally (no auth)
app.get("/debug/provider-bids", async (req, res) => {
  try {
    const providerId = Number(req.query.providerId) || 1;
    const bids = await prisma.bid.findMany({
      where: { providerId },
      orderBy: { createdAt: "desc" },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            createdAt: true,
            consumer: { select: { id: true, name: true } },
          },
        },
        counter: true,
      },
    });

    return res.json(bids);
  } catch (err) {
    console.error("/debug/provider-bids error:", err);
    return res.status(500).json({ error: "Failed to fetch debug provider bids." });
  }
});

app.get("/debug/provider-job", async (req, res) => {
  try {
    const jobId = Number(req.query.jobId);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId" });

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        createdAt: true,
        consumer: { select: { id: true, name: true } },
      },
    });

    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json(job);
  } catch (err) {
    console.error("/debug/provider-job error:", err);
    return res.status(500).json({ error: "Failed to fetch debug job." });
  }
});

// --- Provider: Job Details (optionally with this provider's bid) ---
// GET /provider/jobs/:jobId
app.get(
  "/provider/jobs/:jobId",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can view this resource." });
      }

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) {
        return res.status(400).json({ error: "Invalid jobId parameter" });
      }

      let job: any;
      let cls: any | null = null;

      const selectBase = {
        id: true,
        title: true,
        description: true,
        budgetMin: true,
        budgetMax: true,
        location: true,
        status: true,
        awardedAt: true,
        cancelledAt: true,
        cancelledByUserId: true,
        cancellationReasonCode: true,
        cancellationReasonDetails: true,
        createdAt: true,
        consumer: {
          select: { id: true, name: true },
        },
      } as const;

      const selectWithCompletion = {
        ...selectBase,
        completionPendingForUserId: true,
        completedAt: true,
      } as const;

      const selectWithClassification = {
        ...selectBase,
        category: true,
        trade: true,
        urgency: true,
        suggestedTags: true,
      } as const;

      const selectWithClassificationAndCompletion = {
        ...selectWithClassification,
        completionPendingForUserId: true,
        completedAt: true,
      } as const;

      try {
        job = await prisma.job.findUnique({
          where: { id: jobId },
          select: selectWithClassificationAndCompletion,
        });
        if (job) {
          cls = {
            category: job.category,
            trade: job.trade,
            urgency: job.urgency,
            suggestedTags: job.suggestedTags ?? [],
          };
        }
      } catch (err: any) {
        if (!isMissingDbColumnError(err)) throw err;

        // Classification and/or completion fields may not be deployed yet.
        try {
          job = await prisma.job.findUnique({ where: { id: jobId }, select: selectWithCompletion });
        } catch (err2: any) {
          if (!isMissingDbColumnError(err2)) throw err2;
          job = await prisma.job.findUnique({ where: { id: jobId }, select: selectBase });
        }
      }

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      if (!cls) {
        cls = await classifyJob(`${job.title}\n${job.description ?? ""}`);
      }

      job = {
        ...job,
        category: cls.category,
        trade: cls.trade,
        urgency: cls.urgency,
        suggestedTags: cls.suggestedTags ?? [],
        completionPendingForUserId: (job as any).completionPendingForUserId ?? null,
        completedAt: (job as any).completedAt ?? null,
        awardedAt: (job as any).awardedAt ?? null,
        cancelledAt: (job as any).cancelledAt ?? null,
        cancelledByUserId: (job as any).cancelledByUserId ?? null,
        cancellationReasonCode: (job as any).cancellationReasonCode ?? null,
        cancellationReasonDetails: (job as any).cancellationReasonDetails ?? null,
        cancellationReasonLabel: cancellationReasonLabel((job as any).cancellationReasonCode ?? null),
      };

      // Fetch this provider's bid on the job, if any
      const myBid = await prisma.bid.findFirst({
        where: { jobId: job.id, providerId: req.user.userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          message: true,
          createdAt: true,
          status: true,
          counter: {
            select: {
              id: true,
              minAmount: true,
              maxAmount: true,
              amount: true,
              message: true,
              status: true,
              createdAt: true,
            },
          },
        },
      });

      return res.json({
        job,
        myBid: myBid ?? null,
      });
    } catch (err) {
      console.error("Provider Job Details error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching job details." });
    }
  }
);


// POST /jobs/:jobId/reviews  → consumer leaves or updates a review for the provider on this job
app.post(
  "/jobs/:jobId/reviews",
  authMiddleware,
  validate({
    params: jobIdParamsSchema,
    body: z.object({
      rating: z.coerce.number().int().min(1).max(5),
      text: z.string().max(2000).optional(),
      comment: z.string().max(2000).optional(),
    }),
  }),
  createPostJobReviewsHandler({
    prisma,
    moderateReviewText,
    recomputeProviderRating,
    enqueueWebhookEvent,
  })
);

// GET /jobs/:jobId/reviews → list reviews for a job (both sides)
app.get(
  "/jobs/:jobId/reviews",
  authMiddleware,
  validate({ params: jobIdParamsSchema }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const { jobId } = (req as any).validated.params as { jobId: number };

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { id: true, consumerId: true, status: true, title: true },
      });
      if (!job) return res.status(404).json({ error: "Job not found." });

      const acceptedBid = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { providerId: true },
      });

      const allowedUserIds = new Set<number>([job.consumerId]);
      if (acceptedBid) allowedUserIds.add(acceptedBid.providerId);

      if (!isAdmin(req) && !allowedUserIds.has(req.user.userId)) {
        return res.status(403).json({ error: "Not allowed." });
      }

      const reviews = await prisma.review.findMany({
        where: { jobId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          rating: true,
          text: true,
          createdAt: true,
          reviewerUserId: true,
          revieweeUserId: true,
          reviewer: { select: { id: true, name: true, role: true } },
          reviewee: { select: { id: true, name: true, role: true } },
        },
      });

      return res.json({
        job: { id: job.id, title: job.title, status: job.status },
        reviews,
      });
    } catch (err) {
      console.error("GET /jobs/:jobId/reviews error:", err);
      return res.status(500).json({ error: "Internal server error while fetching job reviews." });
    }
  }
);

// GET /providers/:providerId/reviews → list all reviews for a provider
app.get(
  "/providers/:providerId/reviews",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const providerId = Number(req.params.providerId);
      if (Number.isNaN(providerId)) {
        return res
          .status(400)
          .json({ error: "Invalid providerId parameter." });
      }

      // Ensure provider exists and is actually a PROVIDER
      const provider = await prisma.user.findUnique({
        where: { id: providerId },
        include: {
          providerProfile: true,
        },
      });

      if (!provider || provider.role !== "PROVIDER") {
        return res.status(404).json({ error: "Provider not found." });
      }

      const limit = Math.min(parsePositiveInt(req.query.limit, 50, 200), 200);

      // Fetch reviews with job + consumer info
      const reviews = await prisma.review.findMany({
        where: { revieweeUserId: providerId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          rating: true,
          text: true,
          createdAt: true,
          job: {
            select: {
              id: true,
              title: true,
            },
          },
          reviewer: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // If providerProfile exists, use its rating & count; otherwise compute on the fly
      let averageRating = provider.providerProfile?.rating ?? null;
      let reviewCount = provider.providerProfile?.reviewCount ?? null;

      if (averageRating === null || reviewCount === null) {
        const stats = await recomputeProviderRating(providerId);
        averageRating = stats.averageRating;
        reviewCount = stats.reviewCount;
      }

      return res.json({
        provider: {
          id: provider.id,
          name: provider.name,
          email: provider.email,
        },
        ratingSummary: {
          averageRating,
          reviewCount,
        },
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          text: r.text,
          createdAt: r.createdAt,
          job: {
            id: r.job.id,
            title: r.job.title,
          },
          reviewer: {
            id: r.reviewer?.id,
            name: r.reviewer?.name,
          },
        })),
      });
    } catch (err) {
      console.error("GET /providers/:providerId/reviews error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching provider reviews.",
      });
    }
  }
);

// POST /jobs/:jobId/disputes → open a dispute (consumer or accepted/awarded provider)
app.post(
  "/jobs/:jobId/disputes",
  authMiddleware,
  createPostJobDisputesHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// --- Job completion confirmation flow ---
// POST /jobs/:id/mark-complete (either participant)
app.post(
  "/jobs/:id/mark-complete",
  authMiddleware,
  requireVerifiedEmail,
  createPostJobMarkCompleteHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// POST /jobs/:id/start (awarded provider only)
app.post(
  "/jobs/:id/start",
  authMiddleware,
  requireVerifiedEmail,
  createPostJobStartHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// POST /jobs/:id/confirm-complete (the other participant)
app.post(
  "/jobs/:id/confirm-complete",
  authMiddleware,
  requireVerifiedEmail,
  createPostJobConfirmCompleteHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// GET /admin/disputes → list disputes (admin only)
app.get("/admin/disputes", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (status && ["OPEN", "INVESTIGATING", "RESOLVED"].includes(status)) {
      where.status = status;
    }

    const [total, disputes] = await Promise.all([
      prisma.dispute.count({ where }),
      prisma.dispute.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: {
          openedBy: { select: { id: true, name: true, email: true, role: true } },
          job: { select: { id: true, title: true, status: true, consumerId: true } },
        },
      }),
    ]);

    return res.json({
      page,
      pageSize,
      total,
      disputes,
    });
  } catch (err) {
    console.error("GET /admin/disputes error:", err);
    return res.status(500).json({ error: "Internal server error while listing disputes." });
  }
});

// PATCH /admin/disputes/:id → update dispute status/notes (admin only)
app.patch(
  "/admin/disputes/:id",
  authMiddleware,
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      status: z.enum(["OPEN", "INVESTIGATING"]).optional(),
      resolutionNotes: z.string().max(5000).optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const { id } = (req as any).validated.params as { id: number };
      const { status, resolutionNotes } = (req as any).validated.body as {
        status?: "OPEN" | "INVESTIGATING";
        resolutionNotes?: string;
      };

      const existing = await prisma.dispute.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Dispute not found." });

      const nextStatus = status ?? existing.status;

      const dispute = await prisma.dispute.update({
        where: { id },
        data: {
          status: nextStatus,
          resolutionNotes: resolutionNotes?.trim() || existing.resolutionNotes,
          // Resolution that affects job lifecycle must be done via POST /admin/disputes/:id/resolve
          resolvedAt: existing.resolvedAt,
        },
      });

      await enqueueWebhookEvent({
        eventType: "dispute.updated",
        payload: {
          disputeId: dispute.id,
          jobId: dispute.jobId,
          status: dispute.status,
          resolvedAt: dispute.resolvedAt,
        },
      });

      return res.json({ dispute });
    } catch (err) {
      console.error("PATCH /admin/disputes/:id error:", err);
      return res.status(500).json({ error: "Internal server error while updating dispute." });
    }
  }
);

// POST /admin/disputes/:id/resolve → resolve dispute + set job status (admin only)
app.post(
  "/admin/disputes/:id/resolve",
  authMiddleware,
  createPostAdminResolveDisputeHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// GET /me/inbox → list "threads" across all jobs for current user
// Returns: job summary + lastMessage + unreadCount + lastReadAt
app.get("/me/inbox", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    // Role-based scoping: which jobs count as "my threads"
    // - CONSUMER: jobs I own
    // - PROVIDER: jobs I've bid on
    // - ADMIN: all jobs (but only those with messages, for sanity)
    let roleWhere: any = {};
    if (!isAdmin(req)) {
      if (req.user.role === "CONSUMER") {
        roleWhere = { consumerId: req.user.userId };
      } else if (req.user.role === "PROVIDER") {
        roleWhere = { bids: { some: { providerId: req.user.userId } } };
      } else {
        // Non-admin non-consumer/provider should not happen, but keep it safe:
        return res.status(403).json({ error: "Unsupported role for inbox." });
      }
    }

    // Only include jobs that actually have at least one visible message for this user.
    // (Otherwise “threads” would be empty/noisy.)
    const jobs = await prisma.job.findMany({
      where: {
        ...jobWhereVisible,
        ...roleWhere,
        messages: {
          some: {
            ...messageWhereVisible,
          },
        },
      },
      select: {
        id: true,
        title: true,
        location: true,
        status: true,
        createdAt: true,
        // Fetch the latest visible message as "lastMessage"
        messages: {
          where: { ...messageWhereVisible },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            text: true,
            senderId: true,
            createdAt: true,
            isHidden: true, // admin can see hidden; for non-admin this should always be false due to messageWhereVisible
          },
        },
      },
      // lightweight ordering: newest threads first (based on latest visible message timestamp)
      // NOTE: Prisma can't orderBy relation aggregate cleanly in all versions, so we sort in memory after.
      skip,
      take: pageSize,
    });

    // Pull read states in one query
    const jobIds = jobs.map((j) => j.id);
    const states = await prisma.jobMessageReadState.findMany({
      where: { userId: req.user.userId, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });
    const lastReadAtByJobId = new Map<number, Date>(
      states.map((s) => [s.jobId, s.lastReadAt])
    );

    // Compute unread counts (lightweight N jobs → N counts; OK for <= 50 threads)
    const threads = await Promise.all(
      jobs.map(async (job) => {
        const lastMessage = job.messages[0] ?? null;
        const lastReadAt = lastReadAtByJobId.get(job.id) ?? new Date(0);

        const unreadCount = await prisma.message.count({
          where: {
            jobId: job.id,
            ...messageWhereVisible,
            createdAt: { gt: lastReadAt },
            senderId: { not: req.user!.userId },
          },
        });

        return {
          job: {
            id: job.id,
            title: job.title,
            location: job.location,
            status: job.status,
            createdAt: job.createdAt,
          },
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                text: lastMessage.text,
                senderId: lastMessage.senderId,
                createdAt: lastMessage.createdAt,
                isHidden: lastMessage.isHidden,
              }
            : null,
          unreadCount,
          lastReadAt,
        };
      })
    );

    // Sort in memory by lastMessage.createdAt desc (stable UX even if DB ordering differs)
    threads.sort((a, b) => {
      const at = a.lastMessage?.createdAt?.getTime?.() ?? 0;
      const bt = b.lastMessage?.createdAt?.getTime?.() ?? 0;
      return bt - at;
    });

    return res.json({
      page,
      pageSize,
      threads,
    });
  } catch (err) {
    console.error("GET /me/inbox error:", err);
    return res.status(500).json({ error: "Internal server error while fetching inbox." });
  }
});

// GET /me/inbox/unread-total → total unread messages across all job threads for current user
app.get("/me/inbox/unread-total", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    // 1) Determine the set of jobIds that are "threads" for this user
    // - CONSUMER: jobs I own
    // - PROVIDER: jobs I've bid on
    // - ADMIN: all jobs (but we'll still only count messages visible to admin)
    let roleWhere: any = {};
    if (!isAdmin(req)) {
      if (req.user.role === "CONSUMER") {
        roleWhere = { consumerId: req.user.userId };
      } else if (req.user.role === "PROVIDER") {
        roleWhere = { bids: { some: { providerId: req.user.userId } } };
      } else {
        return res.status(403).json({ error: "Unsupported role for inbox." });
      }
    }

    const jobs = await prisma.job.findMany({
      where: {
        ...jobWhereVisible,
        ...roleWhere,
        // only jobs that have at least one visible message (so we count "threads" that exist)
        messages: { some: { ...messageWhereVisible } },
      },
      select: { id: true },
    });

    const jobIds = jobs.map((j) => j.id);
    if (jobIds.length === 0) {
      return res.json({ totalUnread: 0 });
    }

    // 2) Load read states for these jobs
    const states = await prisma.jobMessageReadState.findMany({
      where: { userId: req.user.userId, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });

    const lastReadAtByJobId = new Map<number, Date>(
      states.map((s) => [s.jobId, s.lastReadAt])
    );

    // 3) Optimization: fetch messages newer than the *minimum* lastReadAt among threads
    // (then filter precisely in memory per job)
    let minLastReadAt = new Date(0);
    if (states.length > 0) {
      minLastReadAt = states.reduce(
        (min, s) => (s.lastReadAt < min ? s.lastReadAt : min),
        states[0].lastReadAt
      );
    }

    const candidateMessages = await prisma.message.findMany({
      where: {
        jobId: { in: jobIds },
        ...messageWhereVisible,
        senderId: { not: req.user.userId },
        createdAt: { gt: minLastReadAt },
      },
      select: {
        jobId: true,
        createdAt: true,
      },
    });

    // 4) Exact count: message is unread if createdAt > lastReadAt for that job
    let totalUnread = 0;
    for (const m of candidateMessages) {
      const lastReadAt = lastReadAtByJobId.get(m.jobId) ?? new Date(0);
      if (m.createdAt > lastReadAt) totalUnread += 1;
    }

    return res.json({ totalUnread });
  } catch (err) {
    console.error("GET /me/inbox/unread-total error:", err);
    return res.status(500).json({ error: "Internal server error while fetching unread total." });
  }
});

// GET /me/inbox/threads
// Returns: per-job "thread" objects with lastMessage + unreadCount, newest first.
// Query params:
//   - limit (default 20, max 50)
//   - cursor (optional): base64 JSON { createdAt: string, id: number }
// Cursor is based on the lastMessage (createdAt + id) from the previous page.
app.get("/me/inbox/threads", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

    // Cursor parsing: base64(JSON.stringify({ createdAt, id }))
    let cursor: { createdAt: Date; id: number } | null = null;
    if (typeof req.query.cursor === "string" && req.query.cursor.trim() !== "") {
      try {
        const decoded = Buffer.from(req.query.cursor, "base64").toString("utf8");
        const parsed = JSON.parse(decoded) as { createdAt: string; id: number };
        const d = new Date(parsed.createdAt);
        if (!Number.isNaN(d.getTime()) && typeof parsed.id === "number") {
          cursor = { createdAt: d, id: parsed.id };
        }
      } catch {
        return res.status(400).json({ error: "Invalid cursor." });
      }
    }

    const { jobWhereVisible, messageWhereVisible } = visibilityFilters(req);

    const me = req.user.userId;

    // Jobs the user is allowed to have "threads" for:
    // - Admin: can see all jobs (subject to visibility filters; for admins these usually allow all)
    // - Consumer: jobs they own
    // - Provider: jobs where they've bid
    const participantJobWhere = isAdmin(req)
      ? { ...jobWhereVisible }
      : {
          ...jobWhereVisible,
          OR: [
            { consumerId: me },
            { bids: { some: { providerId: me } } },
          ],
        };

    // Cursor filter for "newest first" paging, based on lastMessage.createdAt then lastMessage.id.
    // We apply it to the message query so we're paging by the "latest message per job".
    const cursorMessageWhere =
      cursor === null
        ? {}
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          };

    // 1) Grab the latest visible message PER JOB using `distinct: ["jobId"]`
    // Ordered by createdAt desc (and id desc for stability), then distinct keeps first per job.
    const latestMessages = await prisma.message.findMany({
      where: {
        ...messageWhereVisible,
        ...cursorMessageWhere,
        job: participantJobWhere,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["jobId"],
      take: limit,
      select: {
        id: true,
        jobId: true,
        senderId: true,
        text: true,
        createdAt: true,
        sender: { select: { id: true, name: true, email: true, role: true } },
        job: {
          select: {
            id: true,
            title: true,
            status: true,
            location: true,
            consumerId: true,
          },
        },
      },
    });

    // If no threads, done.
    if (latestMessages.length === 0) {
      return res.json({ threads: [], nextCursor: null });
    }

    const jobIds = latestMessages.map((m) => m.jobId);

    // 2) Load read states for these jobs
    const readStates = await prisma.jobMessageReadState.findMany({
      where: { userId: me, jobId: { in: jobIds } },
      select: { jobId: true, lastReadAt: true },
    });

    const lastReadMap = new Map<number, Date>();
    for (const rs of readStates) lastReadMap.set(rs.jobId, rs.lastReadAt);

    // If a state doesn't exist yet, treat as "never read"
    const epoch = new Date(0);

    // 3) Efficient unread counting:
    // Find the earliest lastReadAt among these threads, fetch only messages after that,
    // then count per-job where message.createdAt > lastReadAt and senderId != me.
    let minLastReadAt = epoch;
    for (const jobId of jobIds) {
      const lr = lastReadMap.get(jobId) ?? epoch;
      if (minLastReadAt.getTime() === 0 || lr < minLastReadAt) minLastReadAt = lr;
    }

    const candidateUnread = await prisma.message.findMany({
      where: {
        jobId: { in: jobIds },
        ...messageWhereVisible,
        createdAt: { gt: minLastReadAt },
        senderId: { not: me }, // don't count your own messages as unread
      },
      select: { jobId: true, createdAt: true },
    });

    const unreadCountMap = new Map<number, number>();
    for (const msg of candidateUnread) {
      const lastReadAt = lastReadMap.get(msg.jobId) ?? epoch;
      if (msg.createdAt > lastReadAt) {
        unreadCountMap.set(msg.jobId, (unreadCountMap.get(msg.jobId) ?? 0) + 1);
      }
    }

    // 4) Build response
    const threads = latestMessages.map((m) => ({
      job: m.job,
      lastMessage: {
        id: m.id,
        jobId: m.jobId,
        senderId: m.senderId,
        sender: m.sender,
        text: m.text,
        createdAt: m.createdAt,
      },
      unreadCount: unreadCountMap.get(m.jobId) ?? 0,
    }));

    // Next cursor = the last item in this page (oldest among returned latestMessages)
    const last = latestMessages[latestMessages.length - 1];
    const nextCursor = Buffer.from(
      JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
      "utf8"
    ).toString("base64");

    return res.json({ threads, nextCursor });
  } catch (err) {
    console.error("GET /me/inbox/threads error:", err);
    return res.status(500).json({ error: "Internal server error while fetching inbox threads." });
  }
});

// GET /jobs/:id/messages/read-states
// Returns read states for participants in this job thread.
// Consumer/provider/admin visibility respected via authMiddleware + visibilityFilters.
app.get("/jobs/:id/messages/read-states", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const jobId = Number(req.params.id);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: "Invalid job id." });

    const { jobWhereVisible } = visibilityFilters(req);
    const me = req.user.userId;

    // Ensure the user can see this job
    const job = await prisma.job.findFirst({
      where: { id: jobId, ...jobWhereVisible },
      select: { id: true, consumerId: true },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    // Non-admin must be a participant (consumer OR provider who bid)
    if (!isAdmin(req)) {
      if (req.user.role === "CONSUMER") {
        if (job.consumerId !== me) return res.status(403).json({ error: "Not allowed." });
      } else if (req.user.role === "PROVIDER") {
        const hasBid = await prisma.bid.findFirst({
          where: { jobId, providerId: me },
          select: { id: true },
        });
        if (!hasBid) return res.status(403).json({ error: "Not allowed." });
      } else {
        return res.status(403).json({ error: "Not allowed." });
      }
    }

    const states = await prisma.jobMessageReadState.findMany({
      where: { jobId },
      select: { userId: true, lastReadAt: true },
    });

    return res.json({ states });
  } catch (err) {
    console.error("GET /jobs/:id/messages/read-states error:", err);
    return res.status(500).json({ error: "Internal server error while fetching read states." });
  }
});


// GET /me/reviews → if I'm a provider, see my own reviews + summary
app.get("/me/reviews", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers have reviews to view here." });
    }

    const providerId = req.user.userId;

    const reviews = await prisma.review.findMany({
      where: { revieweeUserId: providerId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        rating: true,
        text: true,
        createdAt: true,
        job: {
          select: {
            id: true,
            title: true,
            location: true,
          },
        },
        reviewer: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const agg = await prisma.review.aggregate({
      where: { revieweeUserId: providerId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    return res.json({
      providerId,
      summary: {
        averageRating: agg._avg.rating ?? null,
        reviewCount: agg._count.rating,
      },
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        text: r.text,
        createdAt: r.createdAt,
        job: r.job
          ? {
              id: r.job.id,
              title: r.job.title,
              location: r.job.location,
            }
          : null,
        reviewer: {
          id: r.reviewer?.id,
          name: r.reviewer?.name,
        },
      })),
    });
  } catch (err) {
    console.error("GET /me/reviews error:", err);
    return res
      .status(500)
      .json({ error: "Internal server error while fetching my reviews." });
  }
});


// GET /providers/top?limit=10
app.get(
  "/providers/top",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 10, 50);
      const zip = typeof req.query.zip === "string" ? req.query.zip : undefined;
      const boostedZip = normalizeZipForBoost({ zip });

      const { userWhereVisible } = visibilityFilters(req);

      const profilesWindow = await prisma.providerProfile.findMany({
        where: {
          provider: {
            role: "PROVIDER",
            ...userWhereVisible, // ✅ hide suspended providers for non-admin
          },
        },
        orderBy: [{ rating: "desc" }, { reviewCount: "desc" }],
        take: Math.min(Math.max(limit * 5, limit), 200),
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
              email: true,
              phone: true,
              location: true,
              subscription: { select: { tier: true } },
              providerStats: {
                select: {
                  avgRating: true,
                  ratingCount: true,
                  jobsCompleted30d: true,
                  medianResponseTimeSeconds30d: true,
                  cancellationRate30d: true,
                  disputeRate30d: true,
                  reportRate30d: true,
                  updatedAt: true,
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
        }
      });

      const ranked = profilesWindow
        .map((p) => {
          const entitlement = p.provider.providerEntitlement;
          const verificationBadge = Boolean(entitlement?.verificationBadge ?? p.verificationBadge);

          const featuredZipCodes = entitlement?.featuredZipCodes ?? p.featuredZipCodes ?? [];
          const isFeaturedForZip = boostedZip ? featuredZipCodes.includes(boostedZip) : false;
          const subscriptionTier = p.provider.subscription?.tier ?? "FREE";

          const stats = p.provider.providerStats;
          const avgRating = stats?.avgRating ?? p.rating ?? null;
          const ratingCount = stats?.ratingCount ?? p.reviewCount ?? 0;

          const viewerZip = boostedZip;
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

          return { profile: p, verificationBadge, isFeaturedForZip, ranking, stats };
        })
        .sort((a, b) => {
          if (b.ranking.finalScore !== a.ranking.finalScore) return b.ranking.finalScore - a.ranking.finalScore;

          const ar = a.profile.rating ?? 0;
          const br = b.profile.rating ?? 0;
          if (br !== ar) return br - ar;

          const ac = a.profile.reviewCount ?? 0;
          const bc = b.profile.reviewCount ?? 0;
          if (bc !== ac) return bc - ac;

          const an = a.profile.provider.name ?? "";
          const bn = b.profile.provider.name ?? "";
          const nameCmp = an.localeCompare(bn);
          if (nameCmp !== 0) return nameCmp;

          return a.profile.provider.id - b.profile.provider.id;
        })
        .slice(0, limit);

      // Favorites (provider favorites) for consumer
      let favoriteIds = new Set<number>();
      if (req.user?.role === "CONSUMER" && ranked.length > 0) {
        const providerIds = ranked.map((it) => it.profile.provider.id);
        const favorites = await prisma.favoriteProvider.findMany({
          where: {
            consumerId: req.user.userId,
            providerId: { in: providerIds },
          },
        });
        favoriteIds = new Set(favorites.map((f) => f.providerId));
      }

      return res.json(
        ranked.map(({ profile: p, verificationBadge, isFeaturedForZip, ranking, stats }) => ({
          id: p.provider.id,
          name: p.provider.name,
          email: p.provider.email,
          phone: p.provider.phone,
          location: p.provider.location,
          experience: p.experience,
          specialties: p.specialties,
          rating: stats?.avgRating ?? p.rating,
          reviewCount: stats?.ratingCount ?? p.reviewCount,
          verificationBadge,
          verificationStatus: p.provider.providerVerification?.status ?? "NONE",
          isVerified: p.provider.providerVerification?.status === "VERIFIED",
          isFeaturedForZip,
          ranking: {
            baseScore: ranking.baseScore,
            distanceScore: ranking.distanceScore,
            ratingScore: ranking.ratingScore,
            responseScore: ranking.responseScore,
            tierBoost: ranking.tierBoost,
            featuredBoost: ranking.featuredBoost,
            verifiedBoost: ranking.verifiedBoost,
            finalScore: ranking.finalScore,
          },
          stats: stats
            ? {
                avgRating: stats.avgRating,
                ratingCount: stats.ratingCount,
                jobsCompleted30d: stats.jobsCompleted30d,
                medianResponseTimeSeconds30d: stats.medianResponseTimeSeconds30d,
                cancellationRate30d: stats.cancellationRate30d,
                disputeRate30d: stats.disputeRate30d,
                reportRate30d: stats.reportRate30d,
                updatedAt: stats.updatedAt,
              }
            : null,
          isFavorited:
            req.user?.role === "CONSUMER" ? favoriteIds.has(p.provider.id) : false,
          categories: p.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })),
        }))
      );
    } catch (err) {
      console.error("GET /providers/top error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching top providers." });
    }
  }
);


// GET /providers/search
// Marketplace provider search with filters + deterministic ranking.
app.get("/providers/search", authMiddleware, createGetProvidersSearchHandler({ prisma }));

// GET /providers/search/feed
// Cursor-based provider feed (stable ordering by providerId)
// Query params:
//   cursor?: number (providerId)
//   limit?: number (default 20, max 50)
app.get("/providers/search/feed", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { cursor, limit, zip, location } = req.query as {
      cursor?: string;
      limit?: string;
      zip?: string;
      location?: string;
    };
    const take = parsePositiveInt(limit, 20, 50);
    const cursorId = parseOptionalCursorId(cursor);
    const boostedZip = normalizeZipForBoost({ zip, location });

    const { userWhereVisible } = visibilityFilters(req);

    const where: any = {
      provider: {
        role: "PROVIDER",
        ...userWhereVisible,
      },
    };

    const profiles = await prisma.providerProfile.findMany({
      where,
      orderBy: [{ providerId: "desc" }],
      take,
      ...(cursorId ? { cursor: { providerId: cursorId }, skip: 1 } : {}),
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
            email: true,
            phone: true,
            location: true,
            subscription: { select: { tier: true } },
            providerStats: {
              select: {
                avgRating: true,
                ratingCount: true,
                jobsCompleted30d: true,
                medianResponseTimeSeconds30d: true,
                cancellationRate30d: true,
                disputeRate30d: true,
                reportRate30d: true,
                updatedAt: true,
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

    let favoriteIds = new Set<number>();
    if (req.user.role === "CONSUMER" && profiles.length > 0) {
      const providerIds = profiles.map((p) => p.provider.id);
      const favorites = await prisma.favoriteProvider.findMany({
        where: { consumerId: req.user.userId, providerId: { in: providerIds } },
        select: { providerId: true },
      });
      favoriteIds = new Set(favorites.map((f) => f.providerId));
    }

    const nextCursor = profiles.length === take ? profiles[profiles.length - 1].provider.id : null;

    return res.json({
      items: profiles.map((p) => ({
        id: p.provider.id,
        name: p.provider.name,
        email: p.provider.email,
        phone: p.provider.phone,
        location: p.provider.location,
        experience: p.experience,
        specialties: p.specialties,
        rating: p.provider.providerStats?.avgRating ?? p.rating,
        reviewCount: p.provider.providerStats?.ratingCount ?? p.reviewCount,
        verificationBadge: Boolean(p.provider.providerEntitlement?.verificationBadge ?? p.verificationBadge),
        verificationStatus: p.provider.providerVerification?.status ?? "NONE",
        isVerified: p.provider.providerVerification?.status === "VERIFIED",
        isFeaturedForZip: boostedZip
          ? (p.provider.providerEntitlement?.featuredZipCodes ?? p.featuredZipCodes ?? []).includes(boostedZip)
          : false,
        ranking: (() => {
          const featuredZipCodes = p.provider.providerEntitlement?.featuredZipCodes ?? p.featuredZipCodes ?? [];
          const isFeaturedForZip = boostedZip ? featuredZipCodes.includes(boostedZip) : false;
          const subscriptionTier = p.provider.subscription?.tier ?? "FREE";
          const stats = p.provider.providerStats;
          const avgRating = stats?.avgRating ?? p.rating ?? null;
          const ratingCount = stats?.ratingCount ?? p.reviewCount ?? 0;

          const verificationBadge = Boolean(p.provider.providerEntitlement?.verificationBadge ?? p.verificationBadge);

          const viewerZip = boostedZip;
          const providerZip = extractZip5(p.provider.location ?? null);
          const distanceMiles =
            viewerZip && providerZip
              ? viewerZip === providerZip
                ? 0
                : (zipcodes.distance(viewerZip, providerZip) as number | null)
              : null;

          return rankProvider({
            distanceMiles,
            avgRating,
            ratingCount,
            medianResponseTimeSeconds30d: stats?.medianResponseTimeSeconds30d ?? null,
            subscriptionTier,
            isFeaturedForZip,
            verificationBadge,
          });
        })(),
        stats: p.provider.providerStats
          ? {
              avgRating: p.provider.providerStats.avgRating,
              ratingCount: p.provider.providerStats.ratingCount,
              jobsCompleted30d: p.provider.providerStats.jobsCompleted30d,
              medianResponseTimeSeconds30d: p.provider.providerStats.medianResponseTimeSeconds30d,
              cancellationRate30d: p.provider.providerStats.cancellationRate30d,
              disputeRate30d: p.provider.providerStats.disputeRate30d,
              reportRate30d: p.provider.providerStats.reportRate30d,
              updatedAt: p.provider.providerStats.updatedAt,
            }
          : null,
        isFavorited: req.user.role === "CONSUMER" ? favoriteIds.has(p.provider.id) : false,
        categories: p.categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      })),
      pageInfo: { limit: take, nextCursor },
    });
  } catch (err) {
    console.error("GET /providers/search/feed error:", err);
    return res.status(500).json({ error: "Internal server error while fetching provider feed." });
  }
});


// GET /providers/me → current provider's profile
app.get(
  "/providers/me",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      if (req.user.role !== "PROVIDER") {
        return res
          .status(403)
          .json({ error: "Only providers have a provider profile." });
      }

      let provider = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: {
          providerProfile: {
            include: {
              categories: true,
            },
          },
          providerStats: true,
          providerVerification: {
            select: { status: true, method: true, providerSubmittedAt: true, verifiedAt: true },
          },
        },
      });

      // If missing (e.g., new provider), compute on-demand once.
      if (provider && !provider.providerStats) {
        await recomputeProviderStatsForProvider({ prisma, providerId: provider.id });
        provider = await prisma.user.findUnique({
          where: { id: req.user.userId },
          include: {
            providerProfile: {
              include: {
                categories: true,
              },
            },
            providerStats: true,
            providerVerification: {
              select: { status: true, method: true, providerSubmittedAt: true, verifiedAt: true },
            },
          },
        });
      }

      if (!provider) {
        return res.status(404).json({ error: "Provider not found." });
      }

      return res.json({
        id: provider.id,
        name: provider.name,
        email: provider.email,
        phone: provider.phone,
        location: provider.location,
        createdAt: provider.createdAt,
        experience: provider.providerProfile?.experience ?? null,
        specialties: provider.providerProfile?.specialties ?? null,
        rating: provider.providerStats?.avgRating ?? provider.providerProfile?.rating ?? null,
        reviewCount: provider.providerStats?.ratingCount ?? provider.providerProfile?.reviewCount ?? 0,
        verificationBadge: provider.providerProfile?.verificationBadge ?? false,
        verificationStatus: provider.providerVerification?.status ?? "NONE",
        isVerified: provider.providerVerification?.status === "VERIFIED",
        featuredZipCodes: provider.providerProfile?.featuredZipCodes ?? [],
        stats: provider.providerStats
          ? {
              avgRating: provider.providerStats.avgRating,
              ratingCount: provider.providerStats.ratingCount,
              jobsCompletedAllTime: provider.providerStats.jobsCompletedAllTime,
              jobsCompleted30d: provider.providerStats.jobsCompleted30d,
              medianResponseTimeSeconds30d: provider.providerStats.medianResponseTimeSeconds30d,
              cancellationRate30d: provider.providerStats.cancellationRate30d,
              disputeRate30d: provider.providerStats.disputeRate30d,
              reportRate30d: provider.providerStats.reportRate30d,
              updatedAt: provider.providerStats.updatedAt,
            }
          : null,
        categories:
          provider.providerProfile?.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })) ?? [],
      });
    } catch (err) {
      console.error("GET /providers/me error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching profile." });
    }
  }
);

// -----------------------------
// Provider Verification
// -----------------------------

const providerVerificationSubmitSchema = {
  body: z.object({
    method: z.enum(["ID", "BACKGROUND_CHECK"]).optional(),
    attachmentIds: z.array(z.coerce.number().int().positive()).optional(),
    externalReference: z.string().max(200).optional(),
    metadataJson: z.record(z.any()).optional(),
  }),
};

// GET /provider/verification/status
app.get("/provider/verification/status", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can access verification." });
    }

    const row = await prisma.providerVerification.findUnique({
      where: { providerId: req.user.userId },
      select: {
        providerId: true,
        status: true,
        method: true,
        providerSubmittedAt: true,
        verifiedAt: true,
        metadataJson: true,
        updatedAt: true,
        createdAt: true,
        attachments: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            mimeType: true,
            filename: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
      },
    });

    return res.json({
      providerId: req.user.userId,
      status: row?.status ?? "NONE",
      method: row?.method ?? null,
      providerSubmittedAt: row?.providerSubmittedAt ?? null,
      verifiedAt: row?.verifiedAt ?? null,
      metadataJson: row?.metadataJson ?? null,
      createdAt: row?.createdAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      attachments: (row?.attachments ?? []).map((a) => ({
        ...a,
        url: `${(process.env.PUBLIC_BASE_URL ?? "").trim() || `${req.protocol}://${req.get("host")}`}/provider/verification/attachments/${a.id}`,
      })),
    });
  } catch (err) {
    console.error("GET /provider/verification/status error:", err);
    return res.status(500).json({ error: "Internal server error while fetching verification status." });
  }
});

// POST /provider/verification/attachments/upload
// Multipart: file=<binary>
app.post(
  "/provider/verification/attachments/upload",
  authMiddleware,
  requireVerifiedEmail,
  uploadSingleVerificationAttachment,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can upload verification documents." });
      }

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ error: "file is required" });
      }

      // Ensure parent record exists so the FK can be satisfied
      await prisma.providerVerification.upsert({
        where: { providerId: req.user.userId },
        create: { providerId: req.user.userId },
        update: {},
      });

      const basename = makeUploadBasename(file.originalname);
      const { storageKey, diskPath } = computeNewUploadTargets({
        namespace: "verification",
        ownerId: req.user.userId,
        basename,
        storageProvider: attachmentStorageProvider,
      });

      let cleanupOnDbFailure: null | (() => Promise<void>) = null;
      if (attachmentStorageProvider && storageKey) {
        await attachmentStorageProvider.putObject(storageKey, file.buffer, file.mimetype);
        cleanupOnDbFailure = async () => {
          await attachmentStorageProvider.deleteObject(storageKey).catch(() => null);
        };
      } else if (diskPath) {
        const abs = path.join(UPLOADS_DIR, diskPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, file.buffer);
        cleanupOnDbFailure = async () => {
          await fs.promises.unlink(abs).catch(() => null);
        };
      }

      let attach: any;
      try {
        attach = await prisma.providerVerificationAttachment.create({
          data: {
            providerId: req.user.userId,
            uploaderUserId: req.user.userId,
            diskPath,
            storageKey,
            mimeType: file.mimetype,
            filename: file.originalname || null,
            sizeBytes: file.size || null,
          },
          select: {
            id: true,
            providerId: true,
            mimeType: true,
            filename: true,
            sizeBytes: true,
            createdAt: true,
          },
        });
      } catch (e) {
        await cleanupOnDbFailure?.();
        throw e;
      }

      const publicBase =
        (process.env.PUBLIC_BASE_URL ?? "").trim() ||
        `${req.protocol}://${req.get("host")}`;

      return res.json({
        attachment: {
          ...attach,
          url: `${publicBase}/provider/verification/attachments/${attach.id}`,
        },
      });
    } catch (err) {
      console.error("POST /provider/verification/attachments/upload error:", err);
      return res.status(500).json({ error: "Internal server error while uploading verification document." });
    }
  }
);

// GET /provider/verification/attachments/:id
// Streams a verification attachment from disk if caller is authorized (provider owner or admin).
app.get(
  "/provider/verification/attachments/:id",
  authMiddleware,
  attachmentDownloadLimiter,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const id = Number(req.params.id);
      if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid attachment id" });

      const attach = await prisma.providerVerificationAttachment.findUnique({
        where: { id },
        select: {
          id: true,
          providerId: true,
          mimeType: true,
          filename: true,
          sizeBytes: true,
          diskPath: true,
          storageKey: true,
        },
      });

      if (!attach) return res.status(404).json({ error: "Attachment not found" });

      const authorized =
        isAdmin(req) || (req.user.role === "PROVIDER" && req.user.userId === attach.providerId);

      if (!authorized) {
        return res.status(403).json({ error: "Not allowed to access this attachment." });
      }

      // New path: object storage -> signed URL
      if (attach.storageKey && attachmentStorageProvider) {
        const url = await attachmentStorageProvider.getSignedReadUrl(
          attach.storageKey,
          attachmentsSignedUrlTtlSeconds
        );
        res.setHeader("Cache-Control", "private, max-age=0, no-store");
        return res.redirect(302, url);
      }

      if (!attach.diskPath) {
        return res.status(404).json({ error: "Attachment file is not available." });
      }

      let absPath: string;
      try {
        absPath = resolveDiskPathInsideUploadsDir(UPLOADS_DIR, attach.diskPath);
      } catch {
        return res.status(400).json({ error: "Invalid attachment path." });
      }

      let st: fs.Stats;
      try {
        st = await fs.promises.stat(absPath);
        if (!st.isFile()) return res.status(404).json({ error: "Attachment file not found." });
      } catch {
        return res.status(404).json({ error: "Attachment file not found." });
      }

      const ct = attach.mimeType || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      res.setHeader("X-Content-Type-Options", "nosniff");

      const safeName = sanitizeFilenameForHeader(attach.filename);
      const dispoType = shouldInlineContentType(ct) ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${dispoType}; filename=\"${safeName}\"`);

      if (typeof attach.sizeBytes === "number" && Number.isFinite(attach.sizeBytes) && attach.sizeBytes > 0) {
        res.setHeader("Content-Length", String(attach.sizeBytes));
      } else {
        res.setHeader("Content-Length", String(st.size));
      }

      const stream = fs.createReadStream(absPath);
      stream.on("error", (e) => {
        console.error("Verification attachment stream error:", e);
        if (!res.headersSent) res.status(500).json({ error: "Failed to stream attachment." });
        else res.end();
      });
      return stream.pipe(res);
    } catch (err) {
      console.error("GET /provider/verification/attachments/:id error:", err);
      return res.status(500).json({ error: "Internal server error fetching attachment." });
    }
  }
);

// POST /provider/verification/submit
app.post(
  "/provider/verification/submit",
  authMiddleware,
  requireVerifiedEmail,
  validate(providerVerificationSubmitSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "PROVIDER") {
        return res.status(403).json({ error: "Only providers can submit verification." });
      }

      const { method, attachmentIds, externalReference, metadataJson } = (req as any)
        .validated.body as {
        method?: "ID" | "BACKGROUND_CHECK";
        attachmentIds?: number[];
        externalReference?: string;
        metadataJson?: Record<string, any>;
      };

      if (attachmentIds?.length) {
        const found = await prisma.providerVerificationAttachment.findMany({
          where: { id: { in: attachmentIds }, providerId: req.user.userId },
          select: { id: true },
        });
        if (found.length !== attachmentIds.length) {
          return res.status(400).json({ error: "One or more attachmentIds are invalid." });
        }
      }

      const mergedMeta: any = {
        ...(metadataJson ?? {}),
        ...(externalReference ? { externalReference } : {}),
        ...(attachmentIds?.length ? { attachmentIds } : {}),
      };

      const updated = await prisma.providerVerification.upsert({
        where: { providerId: req.user.userId },
        create: {
          providerId: req.user.userId,
          status: "PENDING",
          method: method ?? null,
          providerSubmittedAt: new Date(),
          verifiedAt: null,
          metadataJson: Object.keys(mergedMeta).length ? mergedMeta : undefined,
        },
        update: {
          status: "PENDING",
          method: method ?? undefined,
          providerSubmittedAt: new Date(),
          verifiedAt: null,
          metadataJson: Object.keys(mergedMeta).length ? mergedMeta : undefined,
        },
        select: {
          providerId: true,
          status: true,
          method: true,
          providerSubmittedAt: true,
          verifiedAt: true,
          metadataJson: true,
          updatedAt: true,
        },
      });

      return res.json({ verification: updated });
    } catch (err) {
      console.error("POST /provider/verification/submit error:", err);
      return res.status(500).json({ error: "Internal server error while submitting verification." });
    }
  }
);

// Admin: list/approve/reject verifications
app.get("/admin/provider-verifications", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { status } = req.query as { status?: string };
    const where: any = {};
    if (status && ["NONE", "PENDING", "VERIFIED", "REJECTED"].includes(status)) {
      where.status = status;
    }

    const rows = await prisma.providerVerification.findMany({
      where,
      orderBy: [{ providerSubmittedAt: "desc" }, { updatedAt: "desc" }],
      select: {
        providerId: true,
        status: true,
        method: true,
        providerSubmittedAt: true,
        verifiedAt: true,
        metadataJson: true,
        updatedAt: true,
        provider: { select: { id: true, name: true, email: true, phone: true } },
        attachments: { select: { id: true, createdAt: true } },
      },
      take: 200,
    });

    return res.json({
      items: rows.map((r) => ({
        providerId: r.providerId,
        status: r.status,
        method: r.method,
        providerSubmittedAt: r.providerSubmittedAt,
        verifiedAt: r.verifiedAt,
        metadataJson: r.metadataJson,
        updatedAt: r.updatedAt,
        provider: r.provider,
        attachmentCount: r.attachments.length,
      })),
    });
  } catch (err) {
    console.error("GET /admin/provider-verifications error:", err);
    return res.status(500).json({ error: "Internal server error while listing provider verifications." });
  }
});

const adminVerificationDecisionSchema = {
  body: z.object({
    notes: z.string().max(2000).optional(),
    reason: z.string().max(500).optional(),
  }),
  params: z.object({ providerId: z.coerce.number().int().positive() }),
};

app.post(
  "/admin/provider-verifications/:providerId/approve",
  authMiddleware,
  validate(adminVerificationDecisionSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { providerId } = (req as any).validated.params as { providerId: number };
      const { notes } = (req as any).validated.body as { notes?: string };

      const updated = await prisma.$transaction(async (tx) => {
        const v = await tx.providerVerification.upsert({
          where: { providerId },
          create: {
            providerId,
            status: "VERIFIED",
            verifiedAt: new Date(),
            metadataJson: { approvedByAdminId: req.user!.userId, notes: notes ?? null },
          },
          update: {
            status: "VERIFIED",
            verifiedAt: new Date(),
            metadataJson: { approvedByAdminId: req.user!.userId, notes: notes ?? null },
          },
          select: { providerId: true, status: true, verifiedAt: true },
        });
        return v;
      });

      return res.json({ verification: updated });
    } catch (err) {
      console.error("POST /admin/provider-verifications/:providerId/approve error:", err);
      return res.status(500).json({ error: "Internal server error while approving verification." });
    }
  }
);

app.post(
  "/admin/provider-verifications/:providerId/reject",
  authMiddleware,
  validate(adminVerificationDecisionSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { providerId } = (req as any).validated.params as { providerId: number };
      const { notes, reason } = (req as any).validated.body as { notes?: string; reason?: string };

      const updated = await prisma.$transaction(async (tx) => {
        const v = await tx.providerVerification.upsert({
          where: { providerId },
          create: {
            providerId,
            status: "REJECTED",
            verifiedAt: null,
            metadataJson: { rejectedByAdminId: req.user!.userId, reason: reason ?? null, notes: notes ?? null },
          },
          update: {
            status: "REJECTED",
            verifiedAt: null,
            metadataJson: { rejectedByAdminId: req.user!.userId, reason: reason ?? null, notes: notes ?? null },
          },
          select: { providerId: true, status: true, verifiedAt: true },
        });
        return v;
      });

      return res.json({ verification: updated });
    } catch (err) {
      console.error("POST /admin/provider-verifications/:providerId/reject error:", err);
      return res.status(500).json({ error: "Internal server error while rejecting verification." });
    }
  }
);

// PUT /providers/me/profile
// Body: { experience?: string, specialties?: string, location?: string }
app.put(
  "/providers/me/profile",
  authMiddleware,
  validate({
    body: z.object({
      experience: z.string().nullable().optional(),
      specialties: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can update a provider profile." });
    }

    const { experience, specialties, location } = (req as any).validated.body as {
      experience?: string | null;
      specialties?: string | null;
      location?: string | null;
    };

    // Update User (location) if provided
    const userUpdateData: any = {};
    if (typeof location === "string") {
      userUpdateData.location = location.trim() || null;
    }

    const [updatedUser, updatedProfile] = await prisma.$transaction([
      prisma.user.update({
        where: { id: req.user.userId },
        data: userUpdateData,
      }),
      prisma.providerProfile.upsert({
        where: { providerId: req.user.userId },
        update: {
          experience: typeof experience === "string" ? experience.trim() || null : undefined,
          specialties: typeof specialties === "string" ? specialties.trim() || null : undefined,
        },
        create: {
          providerId: req.user.userId,
          experience: typeof experience === "string" ? experience.trim() || null : null,
          specialties: typeof specialties === "string" ? specialties.trim() || null : null,
        },
      }),
    ]);

    // ✅ Webhook: provider profile updated
    await enqueueWebhookEvent({
      eventType: "provider.profile_updated",
      payload: {
        providerId: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email, // remove if you want less PII
        phone: updatedUser.phone ?? null,
        location: updatedUser.location ?? null,
        experience: updatedProfile.experience ?? null,
        specialties: updatedProfile.specialties ?? null,
        rating: updatedProfile.rating ?? null,
        reviewCount: updatedProfile.reviewCount ?? 0,
        updatedAt: new Date(),
      },
    });

    return res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      phone: updatedUser.phone,
      location: updatedUser.location,
      experience: updatedProfile.experience,
      specialties: updatedProfile.specialties,
      rating: updatedProfile.rating,
      reviewCount: updatedProfile.reviewCount,
    });
  } catch (err) {
    console.error("PUT /providers/me/profile error:", err);
    return res.status(500).json({
      error: "Internal server error while updating provider profile.",
    });
  }
});

// PUT /providers/me/categories
// Body: { categoryIds: number[] }
app.put(
  "/providers/me/categories",
  authMiddleware,
  validate({
    body: z.object({
      categoryIds: z.array(positiveIntSchema).nonempty("categoryIds must be a non-empty array"),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.user.role !== "PROVIDER") {
      return res.status(403).json({ error: "Only providers can set categories." });
    }

    const { categoryIds } = (req as any).validated.body as { categoryIds: number[] };
    const uniqueIds = Array.from(new Set(categoryIds));

    // Ensure providerProfile exists
    const profile = await prisma.providerProfile.upsert({
      where: { providerId: req.user.userId },
      update: {},
      create: {
        providerId: req.user.userId,
      },
    });

    // Replace categories (clear and connect)
    const updatedProfile = await prisma.providerProfile.update({
      where: { id: profile.id },
      data: {
        categories: {
          set: [], // clear old
          connect: uniqueIds.map((id) => ({ id })),
        },
      },
      include: {
        categories: true,
      },
    });

    // ✅ Webhook: provider categories updated
    await enqueueWebhookEvent({
      eventType: "provider.categories_updated",
      payload: {
        providerId: updatedProfile.providerId,
        categoryIds: updatedProfile.categories.map((c) => c.id),
        categories: updatedProfile.categories.map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
        updatedAt: new Date(),
      },
    });

    return res.json({
      id: updatedProfile.id,
      providerId: updatedProfile.providerId,
      categories: updatedProfile.categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
      })),
    });
  } catch (err) {
    console.error("PUT /providers/me/categories error:", err);
    return res.status(500).json({
      error: "Internal server error while updating provider categories. Ensure categoryIds are valid.",
    });
  }
});

// GET /categories/with-providers?limitPerCategory=3
// Returns categories with providerCount and top providers per category
app.get(
  "/categories/with-providers",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const limitPerCategory = Math.min(
        Number(req.query.limitPerCategory) || 3,
        10
      );

      const categories = await prisma.category.findMany({
        orderBy: { name: "asc" },
        include: {
          providerProfiles: {
            include: {
              provider: true,
            },
          },
        },
      });

      const result = categories.map((cat) => {
        const profiles = cat.providerProfiles;

        // Sort profiles by rating desc, then reviewCount desc
        const sorted = [...profiles].sort((a, b) => {
          const ratingA = a.rating ?? 0;
          const ratingB = b.rating ?? 0;
          if (ratingA !== ratingB) {
            return ratingB - ratingA;
          }
          const reviewsA = a.reviewCount ?? 0;
          const reviewsB = b.reviewCount ?? 0;
          return reviewsB - reviewsA;
        });

        const topProfiles = sorted.slice(0, limitPerCategory);

        return {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          providerCount: profiles.length,
          topProviders: topProfiles.map((p) => ({
            id: p.provider.id,
            name: p.provider.name,
            email: p.provider.email,
            phone: p.provider.phone,
            location: p.provider.location,
            experience: p.experience,
            specialties: p.specialties,
            rating: p.rating,
            reviewCount: p.reviewCount ?? 0,
            verificationBadge: p.verificationBadge,
            featuredZipCodes: p.featuredZipCodes,
          })),
        };
      });

      return res.json(result);
    } catch (err) {
      console.error("GET /categories/with-providers error:", err);
      return res.status(500).json({
        error:
          "Internal server error while fetching categories with providers.",
      });
    }
  }
);


// POST /providers/:id/favorite → consumer favorites a provider
app.post(
  "/providers/:id/favorite",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can favorite providers." });
    }

    const { id: providerId } = (req as any).validated.params as { id: number };

    const provider = await prisma.user.findUnique({
      where: { id: providerId },
      select: { id: true, role: true, isSuspended: true },
    });

    if (!provider || provider.role !== "PROVIDER") {
      return res.status(404).json({ error: "Provider not found" });
    }

    // ✅ Visibility: suspended providers are invisible to non-admins
    if (!isAdmin(req) && provider.isSuspended) {
      return res.status(404).json({ error: "Provider not found" });
    }

    const fav = await prisma.favoriteProvider.upsert({
      where: {
        consumerId_providerId: {
          consumerId: req.user.userId,
          providerId,
        },
      },
      update: {},
      create: {
        consumerId: req.user.userId,
        providerId,
      },
      select: {
        consumerId: true,
        providerId: true,
        createdAt: true,
      },
    });

    // ✅ Webhook: provider favorited
    await enqueueWebhookEvent({
      eventType: "provider.favorited",
      payload: {
        consumerId: fav.consumerId,
        providerId: fav.providerId,
        createdAt: fav.createdAt,
      },
    });

    return res.status(201).json({ message: "Provider favorited." });
  } catch (err) {
    console.error("POST /providers/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while favoriting provider.",
    });
  }
});

// DELETE /providers/:id/favorite → consumer removes favorite
app.delete("/providers/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can unfavorite providers." });
    }

    const providerId = Number(req.params.id);
    if (Number.isNaN(providerId)) {
      return res.status(400).json({ error: "Invalid provider id" });
    }

    const result = await prisma.favoriteProvider.deleteMany({
      where: {
        consumerId: req.user.userId,
        providerId,
      },
    });

    // ✅ Webhook: provider unfavorited (only if deletion happened)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "provider.unfavorited",
        payload: {
          consumerId: req.user.userId,
          providerId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "Provider unfavorited." });
  } catch (err) {
    console.error("DELETE /providers/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while unfavoriting provider.",
    });
  }
});

// GET /me/favorites/providers → list providers this consumer has favorited
app.get(
  "/me/favorites/providers",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });
      if (req.user.role !== "CONSUMER") {
        return res.status(403).json({ error: "Only consumers have favorite providers." });
      }

      const favorites = await prisma.favoriteProvider.findMany({
        where: {
          consumerId: req.user.userId,
          ...(isAdmin(req)
            ? {}
            : {
                // ✅ hide suspended providers for non-admins
                provider: { isSuspended: false },
              }),
        },
        orderBy: { createdAt: "desc" },
        include: {
          provider: {
            include: {
              providerProfile: { include: { categories: true } },
              providerStats: true,
            },
          },
        },
      });

      return res.json(
        favorites.map((fav) => ({
          favoritedAt: fav.createdAt,
          provider: {
            id: fav.provider.id,
            name: fav.provider.name,
            email: fav.provider.email,
            phone: fav.provider.phone,
            location: fav.provider.location,
            experience: fav.provider.providerProfile?.experience ?? null,
            specialties: fav.provider.providerProfile?.specialties ?? null,
            rating: fav.provider.providerStats?.avgRating ?? fav.provider.providerProfile?.rating ?? null,
            reviewCount: fav.provider.providerStats?.ratingCount ?? fav.provider.providerProfile?.reviewCount ?? 0,
            verificationBadge: fav.provider.providerProfile?.verificationBadge ?? false,
            featuredZipCodes: fav.provider.providerProfile?.featuredZipCodes ?? [],
            stats: fav.provider.providerStats
              ? {
                  avgRating: fav.provider.providerStats.avgRating,
                  ratingCount: fav.provider.providerStats.ratingCount,
                  jobsCompletedAllTime: fav.provider.providerStats.jobsCompletedAllTime,
                  jobsCompleted30d: fav.provider.providerStats.jobsCompleted30d,
                  medianResponseTimeSeconds30d: fav.provider.providerStats.medianResponseTimeSeconds30d,
                  cancellationRate30d: fav.provider.providerStats.cancellationRate30d,
                  disputeRate30d: fav.provider.providerStats.disputeRate30d,
                  reportRate30d: fav.provider.providerStats.reportRate30d,
                  updatedAt: fav.provider.providerStats.updatedAt,
                }
              : null,
            isFavorited: true,
            categories:
              fav.provider.providerProfile?.categories.map((c) => ({
                id: c.id,
                name: c.name,
                slug: c.slug,
              })) ?? [],
          },
        }))
      );
    } catch (err) {
      console.error("GET /me/favorites/providers error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching favorite providers.",
      });
    }
  }
);

// GET /me/favorites/jobs → list jobs this user has favorited
app.get(
  "/me/favorites/jobs",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const favorites = await prisma.favoriteJob.findMany({
        where: {
          userId: req.user.userId,
          ...(isAdmin(req)
            ? {}
            : {
                // ✅ enforce job visibility rules for non-admins
                job: {
                  isHidden: false,
                  consumer: { isSuspended: false },
                },
              }),
        },
        orderBy: { createdAt: "desc" },
        include: {
          job: {
            include: {
              consumer: {
                select: { id: true, name: true, location: true },
              },
            },
          },
        },
      });

      return res.json(
        favorites.map((fav) => ({
          favoritedAt: fav.createdAt,
          job: {
            id: fav.job.id,
            title: fav.job.title,
            description: fav.job.description,
            budgetMin: fav.job.budgetMin,
            budgetMax: fav.job.budgetMax,
            status: fav.job.status,
            location: fav.job.location,
            createdAt: fav.job.createdAt,
            isFavorited: true,
            consumer: {
              id: fav.job.consumer.id,
              name: fav.job.consumer.name,
              location: fav.job.consumer.location,
            },
          },
        }))
      );
    } catch (err) {
      console.error("GET /me/favorites/jobs error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching favorite jobs.",
      });
    }
  }
);


// GET /providers/:id → public provider profile
app.get(
  "/providers/:id",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (Number.isNaN(providerId)) {
        return res.status(400).json({ error: "Invalid provider id" });
      }

      const provider = await prisma.user.findUnique({
        where: { id: providerId },
        include: {
          providerProfile: {
            include: { categories: true },
          },
          providerStats: true,
          providerEntitlement: {
            select: { verificationBadge: true },
          },
          providerVerification: {
            select: { status: true, method: true, providerSubmittedAt: true, verifiedAt: true },
          },
        },
      });

      if (!provider || provider.role !== "PROVIDER") {
        return res.status(404).json({ error: "Provider not found" });
      }

      // ✅ Visibility: suspended providers are invisible to non-admins
      if (!isAdmin(req) && provider.isSuspended) {
        return res.status(404).json({ error: "Provider not found" });
      }

      // isFavorited for consumers
      let isFavorited = false;
      if (req.user?.role === "CONSUMER") {
        const fav = await prisma.favoriteProvider.findUnique({
          where: {
            consumerId_providerId: {
              consumerId: req.user.userId,
              providerId: provider.id,
            },
          },
        });
        isFavorited = !!fav;
      }

      return res.json({
        id: provider.id,
        name: provider.name,
        email: provider.email,
        phone: provider.phone,
        location: provider.location,
        createdAt: provider.createdAt,
        experience: provider.providerProfile?.experience ?? null,
        specialties: provider.providerProfile?.specialties ?? null,
        rating: provider.providerStats?.avgRating ?? provider.providerProfile?.rating ?? null,
        reviewCount: provider.providerStats?.ratingCount ?? provider.providerProfile?.reviewCount ?? 0,
        verificationBadge: Boolean(
          provider.providerEntitlement?.verificationBadge ?? provider.providerProfile?.verificationBadge ?? false
        ),
        verificationStatus: provider.providerVerification?.status ?? "NONE",
        isVerified: provider.providerVerification?.status === "VERIFIED",
        // Do not leak featured zip lists on public profile.
        isFavorited,
        stats: provider.providerStats
          ? {
              avgRating: provider.providerStats.avgRating,
              ratingCount: provider.providerStats.ratingCount,
              jobsCompletedAllTime: provider.providerStats.jobsCompletedAllTime,
              jobsCompleted30d: provider.providerStats.jobsCompleted30d,
              medianResponseTimeSeconds30d: provider.providerStats.medianResponseTimeSeconds30d,
              cancellationRate30d: provider.providerStats.cancellationRate30d,
              disputeRate30d: provider.providerStats.disputeRate30d,
              reportRate30d: provider.providerStats.reportRate30d,
              updatedAt: provider.providerStats.updatedAt,
            }
          : null,
        categories:
          provider.providerProfile?.categories.map((c) => ({
            id: c.id,
            name: c.name,
            slug: c.slug,
          })) ?? [],
      });
    } catch (err) {
      console.error("GET /providers/:id error:", err);
      return res
        .status(500)
        .json({ error: "Internal server error while fetching provider." });
    }
  }
);

// GET /providers/:id/stats → provider marketplace stats
app.get(
  "/providers/:id/stats",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (Number.isNaN(providerId)) {
        return res.status(400).json({ error: "Invalid provider id" });
      }

      const provider = await prisma.user.findUnique({
        where: { id: providerId },
        select: { id: true, role: true, isSuspended: true },
      });

      if (!provider || provider.role !== "PROVIDER") {
        return res.status(404).json({ error: "Provider not found" });
      }

      if (!isAdmin(req) && provider.isSuspended) {
        return res.status(404).json({ error: "Provider not found" });
      }

      let stats = await prisma.providerStats.findUnique({ where: { providerId } });

      // If missing (e.g., new provider), compute on-demand once.
      if (!stats) {
        await recomputeProviderStatsForProvider({ prisma, providerId });
        stats = await prisma.providerStats.findUnique({ where: { providerId } });
      }

      if (!stats) {
        return res.json({ providerId, stats: null });
      }

      return res.json({
        providerId,
        stats: {
          avgRating: stats.avgRating,
          ratingCount: stats.ratingCount,
          jobsCompletedAllTime: stats.jobsCompletedAllTime,
          jobsCompleted30d: stats.jobsCompleted30d,
          medianResponseTimeSeconds30d: stats.medianResponseTimeSeconds30d,
          cancellationRate30d: stats.cancellationRate30d,
          disputeRate30d: stats.disputeRate30d,
          reportRate30d: stats.reportRate30d,
          updatedAt: stats.updatedAt,
        },
      });
    } catch (err) {
      console.error("GET /providers/:id/stats error:", err);
      return res.status(500).json({ error: "Internal server error while fetching provider stats." });
    }
  }
);

// -----------------------------
// Messaging endpoints
// -----------------------------

// -----------------------------
// Contact exchange gate
// -----------------------------

app.post(
  "/jobs/:id/contact-exchange/request",
  authMiddleware,
  contactExchangeRequestLimiter,
  express.json(),
  createPostContactExchangeRequestHandler({ prisma: prisma as any, logSecurityEvent })
);

app.post(
  "/jobs/:id/contact-exchange/decide",
  authMiddleware,
  contactExchangeDecideLimiter,
  express.json(),
  createPostContactExchangeDecideHandler({ prisma: prisma as any, logSecurityEvent })
);

app.get(
  "/jobs/:id/contact-exchange",
  authMiddleware,
  createGetContactExchangeHandler({ prisma: prisma as any })
);

// Helper to extract user from Authorization header (Bearer token)
function getUserFromAuthHeader(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.split(" ")[1];

  try {
    // Same secret you used in signup/login
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      userId: number;
      role: string;
      email?: string;
    };
    return decoded;
  } catch (err) {
    console.error("JWT verify error in messages route:", err);
    return null;
  }
}

// GET /jobs/:jobId/messages
// Query params:
//   cursor?: number (messageId)   -> fetch older messages before this id
//   limit?: number (default 30, max 100)
app.get(
  "/jobs/:jobId/messages",
  authMiddleware,
  messageLimiter,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) return res.status(401).json({ error: "Not authenticated" });

      const jobId = Number(req.params.jobId);
      if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId in URL." });

      const { cursor, limit } = req.query as { cursor?: string; limit?: string };
      const take = parsePositiveInt(limit, 30, 100);
      const cursorId = parseOptionalCursorId(cursor);

      let job: any;
      try {
        job = await prisma.job.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            consumerId: true,
            awardedProviderId: true,
            isHidden: true,
            consumer: { select: { isSuspended: true } },
          },
        });
      } catch (err: any) {
        if (!isMissingDbColumnError(err)) throw err;
        job = await prisma.job.findUnique({
          where: { id: jobId },
          select: {
            id: true,
            consumerId: true,
            isHidden: true,
            consumer: { select: { isSuspended: true } },
          },
        });
      }

      if (!job) return res.status(404).json({ error: "Job not found." });

      // job visibility (non-admin)
      if (!isAdmin(req)) {
        if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
        if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
      }

      const isOwner = req.user.userId === job.consumerId;

      let hasBid = false;
      if (!isOwner && req.user.role === "PROVIDER") {
        const bid = await prisma.bid.findFirst({
          where: { jobId, providerId: req.user.userId },
          select: { id: true },
        });
        hasBid = !!bid;
      }

      if (!isOwner && !hasBid && !isAdmin(req)) {
        return res.status(403).json({ error: "Not allowed to view messages for this job." });
      }

      const awardedProviderId = (job as any).awardedProviderId as number | undefined;
      if (
        typeof awardedProviderId === "number" &&
        req.user.role === "PROVIDER" &&
        req.user.userId !== awardedProviderId &&
        !isAdmin(req)
      ) {
        return res.status(403).json({ error: "Not allowed to view messages for this job." });
      }

      const { messageWhereVisible } = visibilityFilters(req);

      // We query newest-first for pagination, then reverse for UI display (oldest->newest)
      const page = await prisma.message.findMany({
        where: { jobId, ...messageWhereVisible },
        orderBy: [{ id: "desc" }],
        take,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        include: {
          sender: { select: { id: true, name: true, role: true } },
          attachments: true,
        },
      });

      const messagesAsc = [...page].reverse();
      const nextCursor = page.length === take ? page[page.length - 1].id : null;

      return res.json({
        items: messagesAsc.map((m) => ({
          id: m.id,
          jobId: m.jobId,
          senderId: m.senderId,
          text: m.text,
          createdAt: m.createdAt,
          sender: m.sender,
          attachments: ((m as any).attachments ?? []).map((a: any) => ({
            ...a,
            url: attachmentPublicUrl(req, a.id),
          })),
        })),
        pageInfo: {
          limit: take,
          nextCursor, // pass this back as ?cursor=... to fetch older messages
        },
      });
    } catch (err) {
      console.error("GET /jobs/:jobId/messages error:", err);
      return res.status(500).json({ error: "Internal server error while fetching messages." });
    }
  }
);


// POST /jobs/:jobId/messages/read → mark thread as read for current user
app.post(
  "/jobs/:jobId/messages/read",
  authMiddleware,
  validate({ params: jobIdParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { jobId } = (req as any).validated.params as { jobId: number };

    let job: any;
    try {
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          awardedProviderId: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    }

    if (!job) return res.status(404).json({ error: "Job not found." });

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const isOwner = req.user.userId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: req.user.userId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to mark messages read for this job." });
    }

    const awardedProviderId = (job as any).awardedProviderId as number | undefined;
    if (
      typeof awardedProviderId === "number" &&
      req.user.role === "PROVIDER" &&
      req.user.userId !== awardedProviderId &&
      !isAdmin(req)
    ) {
      return res.status(403).json({ error: "Not allowed to mark messages read for this job." });
    }

    // Use latest visible message timestamp as the read cutoff (better than just "now")
    const { messageWhereVisible } = visibilityFilters(req);

    const latest = await prisma.message.findFirst({
      where: { jobId, ...messageWhereVisible },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const readAt = latest?.createdAt ?? new Date();

    const state = await prisma.jobMessageReadState.upsert({
      where: {
        jobId_userId: {
          jobId,
          userId: req.user.userId,
        },
      },
      update: { lastReadAt: readAt },
      create: {
        jobId,
        userId: req.user.userId,
        lastReadAt: readAt,
      },
      select: { jobId: true, userId: true, lastReadAt: true },
    });

    // ✅ Webhook: thread read
    await enqueueWebhookEvent({
      eventType: "thread.read",
      payload: {
        jobId,
        userId: req.user.userId,
        readAt: state.lastReadAt,
      },
    });

    return res.json({
      message: "Thread marked as read.",
      readState: state,
    });
  } catch (err) {
    console.error("POST /jobs/:jobId/messages/read error:", err);
    return res.status(500).json({ error: "Internal server error while marking messages read." });
  }
});

// GET /jobs/:jobId/messages/unread-count → unread messages count for current user
app.get("/jobs/:jobId/messages/unread-count", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const jobId = Number(req.params.jobId);
    if (Number.isNaN(jobId)) return res.status(400).json({ error: "Invalid jobId in URL." });

    let job: any;
    try {
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          awardedProviderId: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    }

    if (!job) return res.status(404).json({ error: "Job not found." });

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const isOwner = req.user.userId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: req.user.userId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to view unread count for this job." });
    }

    const awardedProviderId = (job as any).awardedProviderId as number | undefined;
    if (
      typeof awardedProviderId === "number" &&
      req.user.role === "PROVIDER" &&
      req.user.userId !== awardedProviderId &&
      !isAdmin(req)
    ) {
      return res.status(403).json({ error: "Not allowed to view unread count for this job." });
    }

    const state = await prisma.jobMessageReadState.findUnique({
      where: {
        jobId_userId: {
          jobId,
          userId: req.user.userId,
        },
      },
      select: { lastReadAt: true },
    });

    const lastReadAt = state?.lastReadAt ?? new Date(0);

    const { messageWhereVisible } = visibilityFilters(req);

    // Count only messages AFTER lastReadAt, not sent by me, and still visible
    const unreadCount = await prisma.message.count({
      where: {
        jobId,
        ...messageWhereVisible,
        createdAt: { gt: lastReadAt },
        senderId: { not: req.user.userId },
      },
    });

    return res.json({
      jobId,
      lastReadAt,
      unreadCount,
    });
  } catch (err) {
    console.error("GET /jobs/:jobId/messages/unread-count error:", err);
    return res.status(500).json({ error: "Internal server error while fetching unread count." });
  }
});


// POST /jobs/:jobId/messages → send a new message on a job
// Supports:
// - JSON: { text: string }
// - multipart/form-data: text=<string?>, file=<image|video>

const sendMessageSchema = {
  params: z.object({
    jobId: z.coerce.number().int().positive(),
  }),
  // text is optional because attachments can be sent without text
  body: z.object({
    text: z.string().max(4000).optional(),
  }),
};

app.post(
  "/jobs/:jobId/messages",
  authMiddleware,
  requireVerifiedEmail,
  messageSendLimiter,
  validate(sendMessageSchema),
  uploadSingleAttachment,
  async (req: AuthRequest & { validated: Validated<typeof sendMessageSchema> }, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (isRestrictedUser(req) && !isAdmin(req)) {
      return restrictedResponse(res, {
        message: "Your account is temporarily restricted from sending messages. Please try again later.",
        restrictedUntil: req.user.restrictedUntil ?? null,
      });
    }

    const jobId = req.validated.params.jobId;

    const textRaw = typeof (req.body as any)?.text === "string" ? String((req.body as any).text) : "";
    const textTrim = textRaw.trim();

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!textTrim && !file) {
      return res.status(400).json({
        error: "Message text is required unless an attachment is included.",
      });
    }

    // Fetch job so we know who the consumer is (+ visibility basics)
    let job: any;
    try {
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          awardedProviderId: true,
          status: true,
          title: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;
      job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          status: true,
          title: true,
          isHidden: true,
          consumer: { select: { isSuspended: true } },
        },
      });
    }

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // job visibility (non-admin)
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const senderId = req.user.userId;

    // ✅ Enforce participation:
    // - consumer owner OR provider who has bid OR admin
    const isOwner = senderId === job.consumerId;

    let hasBid = false;
    if (!isOwner && req.user.role === "PROVIDER") {
      const bid = await prisma.bid.findFirst({
        where: { jobId, providerId: senderId },
        select: { id: true },
      });
      hasBid = !!bid;
    }

    if (!isOwner && !hasBid && !isAdmin(req)) {
      return res.status(403).json({ error: "Not allowed to message on this job." });
    }

    const awardedProviderId = (job as any).awardedProviderId as number | undefined;
    if (
      typeof awardedProviderId === "number" &&
      req.user.role === "PROVIDER" &&
      senderId !== awardedProviderId &&
      !isAdmin(req)
    ) {
      return res.status(403).json({ error: "Not allowed to message on this job." });
    }

    // Block check (same behavior you had, just now after we know they're a participant)
    if (!isOwner) {
      const blocked = await isBlockedBetween(senderId, job.consumerId);
      if (blocked) {
        return res.status(403).json({
          error: "You cannot send messages on this job because one of you has blocked the other.",
        });
      }
    }

    const messageText = textTrim || (file ? "Attachment" : "");

    const publicBase =
      (process.env.PUBLIC_BASE_URL ?? "").trim() ||
      `${req.protocol}://${req.get("host")}`;

    const appealUrl = (process.env.PUBLIC_APPEAL_URL ?? "").trim() || `${publicBase}/support`;

    // Risk scoring / spam detection (best-effort)
    try {
      const outcome = await moderateJobMessageSend({
        prisma,
        req,
        isAdmin: isAdmin(req),
        jobId,
        jobStatus: (job as any).status,
        senderId,
        messageText,
        appealUrl,
        logSecurityEvent,
      });

      if (outcome.action === "RESTRICTED") {
        return restrictedResponse(res, {
          message: outcome.message,
          restrictedUntil: outcome.restrictedUntil,
        });
      }

      if (outcome.action === "BLOCK") {
        return res.status(outcome.status).json(outcome.body);
      }
    } catch {
      // ignore scoring failures
    }

    let pendingAttachment: null | {
      diskPath: string | null;
      storageKey: string | null;
      rollback: () => Promise<void>;
    } = null;

    if (file) {
      const basename = makeUploadBasename(file.originalname);
      const { storageKey, diskPath } = computeNewUploadTargets({
        namespace: "message",
        ownerId: jobId,
        basename,
        storageProvider: attachmentStorageProvider,
      });

      if (attachmentStorageProvider && storageKey) {
        await attachmentStorageProvider.putObject(storageKey, file.buffer, file.mimetype);
        pendingAttachment = {
          diskPath: null,
          storageKey,
          rollback: async () => {
            await attachmentStorageProvider.deleteObject(storageKey).catch(() => null);
          },
        };
      } else if (diskPath) {
        const abs = path.join(UPLOADS_DIR, diskPath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, file.buffer);
        pendingAttachment = {
          diskPath,
          storageKey: null,
          rollback: async () => {
            await fs.promises.unlink(abs).catch(() => null);
          },
        };
      }
    }

    let created: any;
    try {
      created = await prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            jobId,
            senderId,
            text: messageText,
          },
        });

        let attachments: any[] = [];
        if (file && pendingAttachment) {
          const a = await tx.messageAttachment.create({
            data: {
              messageId: message.id,
              url: "",
              diskPath: pendingAttachment.diskPath,
              storageKey: pendingAttachment.storageKey,
              uploaderUserId: senderId,
              mimeType: file.mimetype,
              filename: file.originalname || null,
              sizeBytes: file.size || null,
            },
          });

          const updated = await tx.messageAttachment.update({
            where: { id: a.id },
            data: { url: `${publicBase}/attachments/${a.id}` },
          });

          attachments = [updated];
        }

        return { message, attachments };
      });
    } catch (e) {
      await pendingAttachment?.rollback();
      throw e;
    }

    // 🔔 Determine who to notify
    let notifiedUserIds: number[] = [];

    if (senderId === job.consumerId) {
      // Consumer → notify providers who have bids
      const bids = await prisma.bid.findMany({
        where: { jobId },
        select: { providerId: true },
        distinct: ["providerId"],
      });

      const providerIds = bids.map((b) => b.providerId).filter((id) => id !== senderId);
      const prefMap = await getNotificationPreferencesMap({
        prisma: prisma as any,
        userIds: providerIds,
      });
      const notifyNow = new Date();

      for (const providerId of providerIds) {
        if (!shouldSendNotification(prefMap.get(providerId), "MESSAGE", notifyNow)) continue;

        notifiedUserIds.push(providerId);
        await createNotification({
          userId: providerId,
          type: "NEW_MESSAGE",
          content: {
            title: "New message",
            body: `New message on job "${job.title}".`,
            jobId: job.id,
          },
        });
      }
    } else {
      // Provider → notify consumer
      const prefMap = await getNotificationPreferencesMap({
        prisma: prisma as any,
        userIds: [job.consumerId],
      });
      const notifyNow = new Date();
      if (shouldSendNotification(prefMap.get(job.consumerId), "MESSAGE", notifyNow)) {
        notifiedUserIds.push(job.consumerId);
        await createNotification({
          userId: job.consumerId,
          type: "NEW_MESSAGE",
          content: {
            title: "New message",
            body: `New message on your job "${job.title}".`,
            jobId: job.id,
          },
        });
      }
    }

    // ✅ Webhook: message sent
    await enqueueWebhookEvent({
      eventType: "message.sent",
      payload: {
        messageId: created.message.id,
        jobId,
        senderId,
        text: created.message.text,
        createdAt: created.message.createdAt,
        consumerId: job.consumerId,
        notifiedUserIds,
        attachments: created.attachments.map((a) => ({
          id: a.id,
          url: `${publicBase}/attachments/${a.id}`,
          mimeType: a.mimeType,
          filename: a.filename,
          sizeBytes: a.sizeBytes,
          createdAt: a.createdAt,
        })),
      },
    });

    return res.status(201).json({
      ...created.message,
      attachments: created.attachments.map((a) => ({
        ...a,
        url: `${publicBase}/attachments/${a.id}`,
      })),
    });
  } catch (err) {
    const msg = String((err as any)?.message || "");
    if (msg.includes("File too large")) {
      return res.status(413).json({
        error: `Attachment exceeds size limit (${MAX_ATTACHMENT_BYTES} bytes).`,
      });
    }
    if (msg.includes("Unsupported file type")) {
      return res.status(415).json({ error: msg });
    }
    console.error("Error creating message:", err);
    return res.status(500).json({
      error: "Internal server error while creating message.",
    });
  }
  }
);

// --- Admin: flagged users/jobs by risk score ---
// GET /admin/risk/flagged?minScore=60&limit=50
app.get("/admin/risk/flagged", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role !== "ADMIN") return res.status(403).json({ error: "Admins only" });

    const minScore = Math.max(Number(req.query.minScore) || RISK_REVIEW_THRESHOLD, 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    try {
      const [users, jobs] = await Promise.all([
        prisma.user.findMany({
          where: {
            OR: [{ riskScore: { gte: minScore } }, { restrictedUntil: { not: null } }],
          },
          orderBy: [{ riskScore: "desc" }, { id: "desc" }],
          take: limit,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            riskScore: true,
            restrictedUntil: true,
            createdAt: true,
            isSuspended: true,
          },
        }),
        prisma.job.findMany({
          where: { riskScore: { gte: minScore } },
          orderBy: [{ riskScore: "desc" }, { id: "desc" }],
          take: limit,
          select: {
            id: true,
            consumerId: true,
            title: true,
            status: true,
            riskScore: true,
            createdAt: true,
            isHidden: true,
            location: true,
          },
        }),
      ]);

      return res.json({ users, jobs, minScore, limit });
    } catch (err: any) {
      if (isMissingDbColumnError(err)) {
        return res.status(501).json({
          error: "Risk scoring columns not available on this server yet. Apply DB migrations and redeploy.",
          code: "RISK_SCORING_NOT_ENABLED",
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("GET /admin/risk/flagged error:", err);
    return res.status(500).json({ error: "Internal server error while fetching flagged items." });
  }
});

// --- Admin: repeated message violations queue ---
// GET /admin/messages/violations?windowMinutes=10&minBlocks=3&limit=50
app.get(
  "/admin/messages/violations",
  authMiddleware,
  createGetAdminMessageViolationsHandler({ prisma: prisma as any })
);

// POST /reports
// Body: { type: "USER" | "JOB" | "MESSAGE", targetId: number, reason: string, details?: string }
app.post(
  "/reports",
  authMiddleware,
  reportLimiter,
  validate({
    body: z.object({
      type: z.enum(["USER", "JOB", "MESSAGE"]),
      targetId: positiveIntSchema,
      reason: z.string().trim().min(1, "reason is required"),
      details: z.string().trim().optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { type, targetId, reason, details } = (req as any).validated.body as {
      type: "USER" | "JOB" | "MESSAGE";
      targetId: number;
      reason: string;
      details?: string;
    };

    const targetIdNum = targetId;
    let targetUserId: number | null = null;
    let targetJobId: number | null = null;
    let targetMessageId: number | null = null;

    // Validate target exists and set appropriate foreign key
    if (type === "USER") {
      if (targetIdNum === req.user.userId) {
        return res.status(400).json({ error: "You cannot report yourself." });
      }

      const user = await prisma.user.findUnique({ where: { id: targetIdNum } });
      if (!user) return res.status(404).json({ error: "Target user not found." });

      targetUserId = targetIdNum;
    } else if (type === "JOB") {
      const job = await prisma.job.findUnique({ where: { id: targetIdNum } });
      if (!job) return res.status(404).json({ error: "Target job not found." });

      targetJobId = targetIdNum;
    } else if (type === "MESSAGE") {
      const message = await prisma.message.findUnique({ where: { id: targetIdNum } });
      if (!message) return res.status(404).json({ error: "Target message not found." });

      targetMessageId = targetIdNum;
    }

    const report = await prisma.report.create({
      data: {
        reporterId: req.user.userId,
        targetType: type as any,
        targetUserId,
        targetJobId,
        targetMessageId,
        reason: reason,
        details: details?.trim() || null,
      },
    });

    // ✅ Webhook: report created
    await enqueueWebhookEvent({
      eventType: "report.created",
      payload: {
        reportId: report.id,
        reporterId: report.reporterId,
        targetType: report.targetType,
        targetUserId: report.targetUserId,
        targetJobId: report.targetJobId,
        targetMessageId: report.targetMessageId,
        status: report.status,
        reason: report.reason,
        details: report.details,
        createdAt: report.createdAt,
      },
    });

    return res.status(201).json({
      message: "Report submitted.",
      report: {
        id: report.id,
        targetType: report.targetType,
        targetUserId: report.targetUserId,
        targetJobId: report.targetJobId,
        targetMessageId: report.targetMessageId,
        status: report.status,
        reason: report.reason,
        details: report.details,
        createdAt: report.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /reports error:", err);
    return res.status(500).json({
      error: "Internal server error while submitting report.",
    });
  }
});

// GET /me/reports → list reports created by the current user
app.get(
  "/me/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const reports = await prisma.report.findMany({
        where: { reporterId: req.user.userId },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        reports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          targetUserId: r.targetUserId,
          targetJobId: r.targetJobId,
          targetMessageId: r.targetMessageId,
          status: r.status,
          reason: r.reason,
          details: r.details,
          adminNotes: r.adminNotes,
          createdAt: r.createdAt,
        }))
      );
    } catch (err) {
      console.error("GET /me/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching your reports.",
      });
    }
  }
);


// --- Consumer: Accept a bid ---
// POST /jobs/:jobId/bids/:bidId/accept
app.post(
  "/jobs/:jobId/bids/:bidId/accept",
  authMiddleware,
  validate({ params: jobBidParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    if (req.user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can accept bids." });
    }

    const { jobId, bidId } = (req as any).validated.params as { jobId: number; bidId: number };

    // Fetch job and verify ownership
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, title: true, status: true, consumerId: true },
    });

    if (!job) return res.status(404).json({ error: "Job not found." });

    if (job.consumerId !== req.user.userId) {
      return res.status(403).json({ error: "You do not own this job." });
    }

    if (job.status !== "OPEN") {
      return res.status(400).json({ error: `Job is not OPEN (current: ${job.status}).` });
    }

    // Ensure bid belongs to this job
    const bid = await prisma.bid.findUnique({
      where: { id: bidId },
      select: { id: true, jobId: true, providerId: true, status: true, amount: true },
    });

    if (!bid || bid.jobId !== job.id) {
      return res.status(404).json({ error: "Bid not found for this job." });
    }

    const previousJobStatus = job.status;
    const now = new Date();

    // Accept in a transaction: accept chosen, decline others, job -> AWARDED
    // Also set award fields if the DB has those columns.
    let result: { accepted: any; updatedJob: any };
    try {
      result = await prisma.$transaction(async (tx) => {
        const accepted = await tx.bid.update({
          where: { id: bidId },
          data: { status: "ACCEPTED" },
        });

        await tx.bid.updateMany({
          where: { jobId: job.id, id: { not: bidId }, status: "PENDING" },
          data: { status: "DECLINED" },
        });

        const updatedJob = await tx.job.update({
          where: { id: job.id },
          data: {
            status: "AWARDED",
            awardedProviderId: bid.providerId,
            awardedAt: now,
          },
        });

        return { accepted, updatedJob };
      });
    } catch (err: any) {
      if (!isMissingDbColumnError(err)) throw err;

      result = await prisma.$transaction(async (tx) => {
        const accepted = await tx.bid.update({
          where: { id: bidId },
          data: { status: "ACCEPTED" },
        });

        await tx.bid.updateMany({
          where: { jobId: job.id, id: { not: bidId }, status: "PENDING" },
          data: { status: "DECLINED" },
        });

        const updatedJob = await tx.job.update({
          where: { id: job.id },
          data: { status: "AWARDED" },
        });

        return { accepted, updatedJob };
      });
    }

    // Notify both parties
    await createNotification({
      userId: bid.providerId,
      type: "JOB_AWARDED",
      content: `You were awarded for "${job.title}".`,
    });
    await createNotification({
      userId: job.consumerId,
      type: "JOB_AWARDED",
      content: `You awarded a provider for "${job.title}".`,
    });

    await logSecurityEvent(req as any, "job.awarded", {
      targetType: "JOB",
      targetId: String(job.id),
      jobId: job.id,
      previousStatus: previousJobStatus,
      newStatus: result.updatedJob.status,
      awardedProviderId: bid.providerId,
      bidId: bid.id,
    });

    // ✅ Webhook 1: bid accepted
    await enqueueWebhookEvent({
      eventType: "bid.accepted",
      payload: {
        bidId: result.accepted.id,
        jobId: job.id,
        consumerId: job.consumerId,
        providerId: bid.providerId,
        amount: bid.amount,
        jobTitle: job.title,
        acceptedAt: now,
      },
    });

    // ✅ Webhook 2: job status changed
    await enqueueWebhookEvent({
      eventType: "job.status_changed",
      payload: {
        jobId: result.updatedJob.id,
        consumerId: job.consumerId,
        previousStatus: previousJobStatus,
        newStatus: result.updatedJob.status,
        jobTitle: job.title,
        changedAt: now,
      },
    });

    return res.json({
      message: "Bid accepted. Job is now AWARDED.",
      job: result.updatedJob,
      acceptedBid: result.accepted,
    });
  } catch (err) {
    console.error("Accept bid error:", err);
    return res.status(500).json({ error: "Internal server error while accepting bid." });
  }
});

// --- Consumer: Award a provider on a job ---
// POST /jobs/:jobId/award
// Body: { bidId: number } OR { providerId: number }
app.post(
  "/jobs/:jobId/award",
  authMiddleware,
  requireVerifiedEmail,
  createPostJobAwardHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// POST /jobs/:jobId/cancel  → consumer/provider cancels a job (with reason)
app.post(
  "/jobs/:jobId/cancel",
  authMiddleware,
  createPostJobCancelHandler({
    prisma,
    createNotification,
    enqueueWebhookEvent,
    auditSecurityEvent: logSecurityEvent,
  })
);

// POST /jobs/:jobId/complete  → consumer marks job as completed
app.post("/jobs/:jobId/complete", validate({ params: jobIdParamsSchema }), async (req, res) => {
  try {
    const user = getUserFromAuthHeader(req);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Only consumers can complete jobs
    if (user.role !== "CONSUMER") {
      return res.status(403).json({ error: "Only consumers can mark jobs as completed." });
    }

    const { jobId } = (req as any).validated.params as { jobId: number };

    // Prefer new two-step completion confirmation flow when DB supports it.
    // If the migration/enum isn't deployed yet, fall back to the legacy direct-COMPLETED behavior.
    const isCompletionNotEnabledError = (err: any) => {
      if (isMissingDbColumnError(err)) return true;
      const msg = String(err?.message ?? "");
      return (
        msg.includes("invalid input value for enum") && msg.includes("COMPLETED_PENDING_CONFIRMATION")
      );
    };

    try {
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          status: true,
          title: true,
          location: true,
          createdAt: true,
          awardedProviderId: true,
          completionPendingForUserId: true,
          completedAt: true,
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      if (job.consumerId !== user.userId) {
        return res.status(403).json({ error: "You can only complete jobs that you created." });
      }

      if (job.status !== "IN_PROGRESS") {
        return res.status(400).json({
          error: `Only jobs that are IN_PROGRESS can be marked as completed. Current status: ${job.status}.`,
        });
      }

      const acceptedBid = await prisma.bid.findFirst({
        where: { jobId, status: "ACCEPTED" },
        select: { providerId: true },
      });
      const providerId = (job as any).awardedProviderId ?? acceptedBid?.providerId ?? null;
      if (!providerId) {
        return res.status(400).json({ error: "No awarded provider for this job." });
      }

      const previousStatus = job.status;
      const now = new Date();

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED_PENDING_CONFIRMATION",
          completionPendingForUserId: providerId,
          completedAt: null,
        },
      });

      await createNotification({
        userId: providerId,
        type: "JOB_COMPLETION_CONFIRM_REQUIRED",
        content: `Job "${job.title}" was marked complete. Please confirm completion.`,
      });
      await createNotification({
        userId: user.userId,
        type: "JOB_COMPLETION_MARKED",
        content: `You marked "${job.title}" complete. Waiting for confirmation.`,
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId: updatedJob.id,
          consumerId: job.consumerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: job.title,
          changedAt: now,
        },
      });

      return res.json({
        message: "Completion requested. Waiting for the provider to confirm.",
        job: updatedJob,
      });
    } catch (err: any) {
      if (!isCompletionNotEnabledError(err)) throw err;

      // ---- Legacy fallback: direct COMPLETED ----
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: {
          id: true,
          consumerId: true,
          status: true,
          title: true,
          location: true,
          createdAt: true,
        },
      });

      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }

      if (job.consumerId !== user.userId) {
        return res.status(403).json({ error: "You can only complete jobs that you created." });
      }

      if (job.status !== "IN_PROGRESS") {
        return res.status(400).json({
          error: `Only jobs that are IN_PROGRESS can be marked as completed. Current status: ${job.status}.`,
        });
      }

      const previousStatus = job.status;

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: { status: "COMPLETED" },
        select: {
          id: true,
          title: true,
          location: true,
          status: true,
          createdAt: true,
        },
      });

      await enqueueWebhookEvent({
        eventType: "job.completed",
        payload: {
          jobId: updatedJob.id,
          consumerId: job.consumerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: updatedJob.title,
          location: updatedJob.location,
          createdAt: updatedJob.createdAt,
          completedAt: new Date(),
        },
      });

      await enqueueWebhookEvent({
        eventType: "job.status_changed",
        payload: {
          jobId: updatedJob.id,
          consumerId: job.consumerId,
          previousStatus,
          newStatus: updatedJob.status,
          title: updatedJob.title,
          changedAt: new Date(),
        },
      });

      return res.json({
        message: "Job marked as completed.",
        job: updatedJob,
      });
    }
  } catch (err) {
    console.error("Error completing job:", err);
    return res.status(500).json({ error: "Internal server error while completing job." });
  }
});

// POST /jobs/:id/favorite → user favorites a job
app.post(
  "/jobs/:id/favorite",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { id: jobId } = (req as any).validated.params as { id: number };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        consumerId: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        isHidden: true,
        consumer: { select: { isSuspended: true } },
      },
    });

    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    // ✅ Visibility (non-admin): hidden jobs / suspended consumers behave like not-found
    if (!isAdmin(req)) {
      if ((job as any).isHidden) return res.status(404).json({ error: "Job not found." });
      if ((job as any).consumer?.isSuspended) return res.status(404).json({ error: "Job not found." });
    }

    const fav = await prisma.favoriteJob.upsert({
      where: {
        userId_jobId: {
          userId: req.user.userId,
          jobId,
        },
      },
      update: {},
      create: {
        userId: req.user.userId,
        jobId,
      },
      select: { userId: true, jobId: true, createdAt: true },
    });

    // ✅ Webhook: job favorited
    await enqueueWebhookEvent({
      eventType: "job.favorited",
      payload: {
        userId: fav.userId,
        jobId: fav.jobId,
        createdAt: fav.createdAt,
        job: {
          id: job.id,
          title: job.title,
          status: job.status,
          location: job.location,
          budgetMin: job.budgetMin,
          budgetMax: job.budgetMax,
          createdAt: job.createdAt,
          consumerId: job.consumerId,
        },
      },
    });

    return res.status(201).json({ message: "Job favorited." });
  } catch (err) {
    console.error("POST /jobs/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while favoriting job.",
    });
  }
});

// DELETE /jobs/:id/favorite → user removes favorite job
app.delete("/jobs/:id/favorite", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const jobId = Number(req.params.id);
    if (Number.isNaN(jobId)) {
      return res.status(400).json({ error: "Invalid job id" });
    }

    const result = await prisma.favoriteJob.deleteMany({
      where: {
        userId: req.user.userId,
        jobId,
      },
    });

    // ✅ Webhook: job unfavorited (only if deletion happened)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "job.unfavorited",
        payload: {
          userId: req.user.userId,
          jobId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "Job unfavorited." });
  } catch (err) {
    console.error("DELETE /jobs/:id/favorite error:", err);
    return res.status(500).json({
      error: "Internal server error while unfavoriting job.",
    });
  }
});

// GET /notifications
// Query params:
//   cursor?: number (notificationId)
//   limit?: number (default 25, max 100)
app.get("/notifications", authMiddleware, notificationsLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = parsePositiveInt(limit, 25, 100);
    const cursorId = parseOptionalCursorId(cursor);

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ id: "desc" }],
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const nextCursor =
      notifications.length === take ? notifications[notifications.length - 1].id : null;

    return res.json({
      items: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        content: n.content,
        read: n.read,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      pageInfo: { limit: take, nextCursor },
    });
  } catch (err) {
    console.error("List notifications error:", err);
    return res.status(500).json({ error: "Internal server error while fetching notifications." });
  }
});

// GET /me/notifications (alias of /notifications)
app.get("/me/notifications", authMiddleware, notificationsLimiter, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    const { cursor, limit } = req.query as { cursor?: string; limit?: string };
    const take = parsePositiveInt(limit, 25, 100);
    const cursorId = parseOptionalCursorId(cursor);

    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ id: "desc" }],
      take,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });

    const nextCursor =
      notifications.length === take ? notifications[notifications.length - 1].id : null;

    return res.json({
      items: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        content: n.content,
        read: n.read,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      pageInfo: { limit: take, nextCursor },
    });
  } catch (err) {
    console.error("List /me/notifications error:", err);
    return res.status(500).json({ error: "Internal server error while fetching notifications." });
  }
});


// POST /notifications/:id/read  → mark a single notification as read
app.post(
  "/notifications/:id/read",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { id: notifId } = (req as any).validated.params as { id: number };

    const notif = await prisma.notification.findUnique({
      where: { id: notifId },
      select: { id: true, userId: true, read: true, readAt: true, type: true, createdAt: true },
    });

    if (!notif || notif.userId !== req.user.userId) {
      return res.status(404).json({ error: "Notification not found." });
    }

    // already read → idempotent response (still OK)
    // If legacy data has read=true but readAt is missing, we backfill readAt on this write.
    const shouldWrite = !notif.read || !notif.readAt;
    const updated = shouldWrite
      ? await prisma.notification.update({
          where: { id: notifId },
          data: { read: true, readAt: notif.readAt ?? new Date() },
          select: { id: true, userId: true, read: true, readAt: true, type: true, createdAt: true },
        })
      : notif;

    // ✅ Webhook (only emit when it actually changed)
    if (!notif.read) {
      await enqueueWebhookEvent({
        eventType: "notification.read",
        payload: {
          notificationId: updated.id,
          userId: updated.userId,
          type: updated.type,
          createdAt: updated.createdAt,
          readAt: updated.readAt ?? new Date(),
        },
      });
    }

    return res.json({
      id: updated.id,
      read: true,
      readAt: updated.readAt ?? null,
    });
  } catch (err) {
    console.error("Mark notification read error:", err);
    return res.status(500).json({ error: "Internal server error while updating notification." });
  }
});

// POST /notifications/read-all  → mark all my notifications as read
app.post("/notifications/read-all", authMiddleware, validate({}), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const result = await prisma.notification.updateMany({
      where: {
        userId: req.user.userId,
        read: false,
      },
      data: { read: true, readAt: new Date() },
    });

    // ✅ Webhook (only if anything changed)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "notification.read_all",
        payload: {
          userId: req.user.userId,
          updatedCount: result.count,
          readAt: new Date(),
        },
      });
    }

    return res.json({
      updatedCount: result.count,
    });
  } catch (err) {
    console.error("Mark all notifications read error:", err);
    return res.status(500).json({ error: "Internal server error while updating notifications." });
  }
});

// POST /users/:id/block → current user blocks another user
app.post(
  "/users/:id/block",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { id: targetId } = (req as any).validated.params as { id: number };

    if (targetId === req.user.userId) {
      return res.status(400).json({ error: "You cannot block yourself." });
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, email: true },
    });

    if (!target) {
      return res.status(404).json({ error: "User not found." });
    }

    // Upsert to avoid duplicates
    const block = await prisma.block.upsert({
      where: {
        blockerId_blockedId: {
          blockerId: req.user.userId,
          blockedId: targetId,
        },
      },
      update: {},
      create: {
        blockerId: req.user.userId,
        blockedId: targetId,
      },
      select: {
        id: true,
        blockerId: true,
        blockedId: true,
        createdAt: true,
      },
    });

    // ✅ Webhook: user blocked
    await enqueueWebhookEvent({
      eventType: "user.blocked",
      payload: {
        blockId: block.id,
        blockerId: block.blockerId,
        blockedId: block.blockedId,
        createdAt: block.createdAt,
      },
    });

    return res.json({
      message: "User blocked.",
      block: {
        id: block.id,
        blockerId: block.blockerId,
        blockedId: block.blockedId,
        createdAt: block.createdAt,
      },
    });
  } catch (err) {
    console.error("POST /users/:id/block error:", err);
    return res.status(500).json({ error: "Internal server error while blocking user." });
  }
});

// DELETE /users/:id/block → current user unblocks another user
app.delete("/users/:id/block", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const targetId = Number(req.params.id);
    if (Number.isNaN(targetId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const result = await prisma.block.deleteMany({
      where: {
        blockerId: req.user.userId,
        blockedId: targetId,
      },
    });

    // ✅ Webhook: user unblocked (only if anything changed)
    if (result.count > 0) {
      await enqueueWebhookEvent({
        eventType: "user.unblocked",
        payload: {
          blockerId: req.user.userId,
          blockedId: targetId,
          deletedAt: new Date(),
        },
      });
    }

    return res.json({ message: "User unblocked (if they were blocked)." });
  } catch (err) {
    console.error("DELETE /users/:id/block error:", err);
    return res.status(500).json({
      error: "Internal server error while unblocking user.",
    });
  }
});

// GET /me/blocks → list users the current user has blocked
app.get(
  "/me/blocks",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const blocks = await prisma.block.findMany({
        where: { blockerId: req.user.userId },
        include: {
          blocked: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return res.json(
        blocks.map((b) => ({
          id: b.id,
          blockedUser: {
            id: b.blocked.id,
            name: b.blocked.name,
            email: b.blocked.email,
            role: b.blocked.role,
          },
          createdAt: b.createdAt,
        }))
      );
    } catch (err) {
      console.error("GET /me/blocks error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching blocks.",
      });
    }
  }
);

// GET /admin/reports
// Query params:
//   status?: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED"
//   type?: "USER" | "JOB" | "MESSAGE"
//   page?: number (default 1)
//   pageSize?: number (default 20, max 100)
app.get(
  "/admin/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const {
        status,
        type,
        page = "1",
        pageSize = "20",
      } = req.query as {
        status?: string;
        type?: string;
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(Number(page) || 1, 1);
      const take = Math.min(Number(pageSize) || 20, 100);
      const skip = (pageNum - 1) * take;

      const where: any = {};

      if (status && ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status)) {
        where.status = status;
      }

      if (type && ["USER", "JOB", "MESSAGE"].includes(type)) {
        where.targetType = type;
      }

      const [reports, total] = await prisma.$transaction([
        prisma.report.findMany({
          where,
          include: {
            reporter: true,
            targetUser: true,
            targetJob: true,
            targetMessage: true,
          },
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.report.count({ where }),
      ]);

      const totalPages = Math.ceil(total / take) || 1;

      return res.json({
        page: pageNum,
        pageSize: take,
        total,
        totalPages,
        reports: reports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          status: r.status,
          reason: r.reason,
          details: r.details,
          adminNotes: r.adminNotes,
          createdAt: r.createdAt,
          reporter: {
            id: r.reporter.id,
            name: r.reporter.name,
            email: r.reporter.email,
            role: r.reporter.role,
          },
          targetUser: r.targetUser
            ? {
                id: r.targetUser.id,
                name: r.targetUser.name,
                email: r.targetUser.email,
                role: r.targetUser.role,
              }
            : null,
          targetJob: r.targetJob
            ? {
                id: r.targetJob.id,
                title: r.targetJob.title,
                consumerId: r.targetJob.consumerId,
              }
            : null,
          targetMessage: r.targetMessage
            ? {
                id: r.targetMessage.id,
                jobId: r.targetMessage.jobId,
                senderId: r.targetMessage.senderId,
                text: r.targetMessage.text,
              }
            : null,
        })),
      });
    } catch (err) {
      console.error("GET /admin/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching reports.",
      });
    }
  }
);

function publicWebhookEndpoint(ep: {
  id: number;
  url: string;
  enabled: boolean;
  events: string[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: ep.id,
    url: ep.url,
    enabled: ep.enabled,
    events: ep.events,
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}


// POST /admin/webhooks/endpoints
app.post(
  "/admin/webhooks/endpoints",
  authMiddleware,
  validate({
    body: z.object({
      url: z.string().trim().min(1, "url is required"),
      events: z
        .array(z.string())
        .transform((events) =>
          Array.from(
            new Set(
              events
                .map((e) => String(e).trim())
                .filter((e) => e.length > 0)
            )
          )
        )
        .refine((events) => events.length <= 50, {
          message: "events must contain at most 50 entries",
        })
        .refine((events) => events.every((e) => e.length <= 100), {
          message: "each event must be at most 100 characters",
        })
        .refine((events) => events.length > 0, {
          message: "events[] is required",
        }),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { url, events } = (req as any).validated.body as { url: string; events: string[] };

    const secret = crypto.randomBytes(32).toString("hex");

    const ep = await prisma.webhookEndpoint.create({
      data: { url, secret, events, enabled: true },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    await prisma.adminAction
      .create({
        data: {
          adminId: req.user!.userId,
          type: "WEBHOOK_ENDPOINT_CREATED" as any,
          entityId: ep.id,
          notes: `Webhook endpoint created: url=${ep.url} enabled=${ep.enabled} events=${JSON.stringify(ep.events)}`,
        },
      })
      .catch(() => null);

    await logSecurityEvent(req, "admin.webhook_endpoint_created", {
      targetType: "WEBHOOK_ENDPOINT",
      targetId: ep.id,
      url: ep.url,
      enabled: ep.enabled,
      eventsCount: ep.events.length,
    });

    // ✅ Return secret ONCE, separate from endpoint object
    return res.json({ endpoint: publicWebhookEndpoint(ep), secret });
  } catch (err) {
    console.error("Create webhook endpoint error:", err);
    return res.status(500).json({ error: "Internal server error creating webhook endpoint." });
  }
});

// GET /admin/webhooks/endpoints
app.get("/admin/webhooks/endpoints", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const endpoints = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    return res.json({ endpoints: endpoints.map(publicWebhookEndpoint) });
  } catch (err) {
    console.error("List webhook endpoints error:", err);
    return res.status(500).json({ error: "Internal server error listing webhook endpoints." });
  }
});


// PATCH /admin/webhooks/endpoints/:id
app.patch(
  "/admin/webhooks/endpoints/:id",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z
      .object({
        url: z.string().trim().min(1).optional(),
        enabled: z.coerce.boolean().optional(),
        events: z
          .array(z.string())
          .transform((events) =>
            Array.from(
              new Set(
                events
                  .map((e) => String(e).trim())
                  .filter((e) => e.length > 0)
              )
            )
          )
          .refine((events) => events.length <= 50, {
            message: "events must contain at most 50 entries",
          })
          .refine((events) => events.every((e) => e.length <= 100), {
            message: "each event must be at most 100 characters",
          })
          .refine((events) => events.length > 0, {
            message: "events must be a non-empty string array",
          })
          .optional(),
      })
      .refine((b) => b.url != null || b.enabled != null || b.events != null, {
        message: "At least one field must be provided",
        path: [],
      }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = (req as any).validated.params as { id: number };
    const { url, enabled, events } = (req as any).validated.body as {
      url?: string;
      enabled?: boolean;
      events?: string[];
    };

    const before = await prisma.webhookEndpoint.findUnique({
      where: { id },
      select: { id: true, url: true, enabled: true, events: true},
    });

    const ep = await prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(url ? { url } : {}),
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(Array.isArray(events) ? { events } : {}),
      },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    // ✅ Audit (AdminAction) — no webhook
    await prisma.adminAction.create({
      data: {
        adminId: req.user!.userId,
        type: "WEBHOOK_ENDPOINT_UPDATED" as any, // only if your enum includes it
        entityId: ep.id,
        notes: `Webhook endpoint updated. before=${JSON.stringify(before)} after=${JSON.stringify({
          id: ep.id,
          url: ep.url,
          enabled: ep.enabled,
          events: ep.events,
        })}`,
      },
    }).catch(() => null);

    await logSecurityEvent(req, "admin.webhook_endpoint_updated", {
      targetType: "WEBHOOK_ENDPOINT",
      targetId: ep.id,
      changed: {
        url: url !== undefined,
        enabled: enabled !== undefined,
        events: events !== undefined,
      },
    });

    return res.json({ endpoint: publicWebhookEndpoint(ep) });
  } catch (err) {
    console.error("Update webhook endpoint error:", err);
    return res.status(500).json({ error: "Internal server error updating webhook endpoint." });
  }
});

// POST /admin/webhooks/endpoints/:id/rotate-secret
app.post(
  "/admin/webhooks/endpoints/:id/rotate-secret",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id } = (req as any).validated.params as { id: number };

    const exists = await prisma.webhookEndpoint.findUnique({
      where: { id },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });
    if (!exists) return res.status(404).json({ error: "Webhook endpoint not found." });

    const newSecret = crypto.randomBytes(32).toString("hex");

    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: { secret: newSecret },
      select: { id: true, url: true, enabled: true, events: true, createdAt: true, updatedAt: true },
    });

    await prisma.adminAction
      .create({
        data: {
          adminId: req.user!.userId,
          type: "WEBHOOK_ENDPOINT_SECRET_ROTATED" as any, // add to enum later if you want
          entityId: updated.id,
          notes: `Webhook endpoint secret rotated: url=${updated.url}`,
        },
      })
      .catch(() => null);

    await logSecurityEvent(req, "admin.webhook_endpoint_secret_rotated", {
      targetType: "WEBHOOK_ENDPOINT",
      targetId: updated.id,
      url: updated.url,
    });

    // ✅ Return secret ONCE here
    return res.json({ endpoint: publicWebhookEndpoint(updated), secret: newSecret });
  } catch (err) {
    console.error("Rotate webhook secret error:", err);
    return res.status(500).json({ error: "Internal server error rotating webhook secret." });
  }
});


// PATCH /admin/reports/:id
// Body: { status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", adminNotes?: string }
app.patch(
  "/admin/reports/:id",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({
      status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"]),
      adminNotes: z.string().trim().optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: reportId } = (req as any).validated.params as { id: number };
    const { status, adminNotes } = (req as any).validated.body as {
      status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
      adminNotes?: string;
    };

    const existing = await prisma.report.findUnique({ where: { id: reportId } });
    if (!existing) {
      return res.status(404).json({ error: "Report not found." });
    }

    const previousStatus = existing.status;

    const updated = await prisma.report.update({
      where: { id: reportId },
      data: {
        status: status as any,
        adminNotes: adminNotes?.trim() ?? undefined,
        handledByAdminId: req.user!.userId,
        handledAt: new Date(),
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "REPORT_STATUS_CHANGED",
      reportId,
      notes: `Status -> ${status}${adminNotes ? ` | ${adminNotes.trim()}` : ""}`,
    });

    // ✅ Webhook: report status changed
    await enqueueWebhookEvent({
      eventType: "report.status_changed",
      payload: {
        reportId: updated.id,
        previousStatus,
        newStatus: updated.status,
        targetType: updated.targetType,
        targetUserId: updated.targetUserId,
        targetJobId: updated.targetJobId,
        targetMessageId: updated.targetMessageId,
        reason: updated.reason,
        details: updated.details,
        adminNotes: updated.adminNotes,
        handledByAdminId: updated.handledByAdminId,
        handledAt: updated.handledAt,
        changedAt: new Date(),
      },
    });

    return res.json({
      message: "Report updated.",
      report: {
        id: updated.id,
        targetType: updated.targetType,
        status: updated.status,
        reason: updated.reason,
        details: updated.details,
        adminNotes: updated.adminNotes,
        handledByAdminId: updated.handledByAdminId,
        handledAt: updated.handledAt,
        targetUserId: updated.targetUserId,
        targetJobId: updated.targetJobId,
        targetMessageId: updated.targetMessageId,
        createdAt: updated.createdAt,
      },
    });
  } catch (err) {
    console.error("PATCH /admin/reports/:id error:", err);
    return res.status(500).json({ error: "Internal server error while updating report." });
  }
});

// GET /admin/stats/reports
// Optional query param:
//   window=24h | 7d | 30d | all   (default: 24h)
app.get(
  "/admin/stats/reports",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      // ---- Time windows (absolute + selectable window) ----
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const { window = "24h" } = req.query as { window?: string };

      let windowStart: Date | null = last24h; // default
      if (window === "7d") windowStart = last7d;
      if (window === "30d") windowStart = last30d;
      if (window === "all") windowStart = null;

      const windowWhere = windowStart ? { createdAt: { gte: windowStart } } : {};

      // 1) Total reports
      const total = await prisma.report.count();

      // 2) By status (OPEN / IN_REVIEW / RESOLVED / DISMISSED)
      const byStatusRaw = await prisma.report.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      const byStatus = {
        OPEN: 0,
        IN_REVIEW: 0,
        RESOLVED: 0,
        DISMISSED: 0,
      } as Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>;

      for (const row of byStatusRaw) {
        byStatus[row.status as keyof typeof byStatus] = row._count._all;
      }

      // 3) By target type (USER / JOB / MESSAGE)
      const byTypeRaw = await prisma.report.groupBy({
        by: ["targetType"],
        _count: { _all: true },
      });

      const byTargetType = {
        USER: 0,
        JOB: 0,
        MESSAGE: 0,
      } as Record<"USER" | "JOB" | "MESSAGE", number>;

      for (const row of byTypeRaw) {
        byTargetType[row.targetType as keyof typeof byTargetType] = row._count._all;
      }

      // 3b) Status counts by targetType (matrix, all-time)
      const byTypeStatusRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        _count: { _all: true },
      });

      const statusCountsByTargetType: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetType[t][s] = row._count._all;
      }

      // 3c) Status counts by targetType (matrix, time-windowed)
      const byTypeStatusWindowRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        where: windowWhere,
        _count: { _all: true },
      });

      const statusCountsByTargetTypeWindow: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusWindowRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetTypeWindow[t][s] = row._count._all;
      }

      // 4) New reports in time windows (absolute)
      const [createdLast24h, createdLast7d, createdLast30d] =
        await prisma.$transaction([
          prisma.report.count({ where: { createdAt: { gte: last24h } } }),
          prisma.report.count({ where: { createdAt: { gte: last7d } } }),
          prisma.report.count({ where: { createdAt: { gte: last30d } } }),
        ]);

      // 5) Top reported users (based on targetUserId)
      // Only reports where targetType=USER and targetUserId is not null
      const topUsersRaw = await prisma.report.groupBy({
        by: ["targetUserId"],
        where: {
          targetType: "USER",
          targetUserId: { not: null },
        },
        _count: {
          targetUserId: true, // count rows in each group
        },
        orderBy: {
          _count: {
            targetUserId: "desc",
          },
        },
        take: 10,
      });

      const userIds = topUsersRaw
        .map((r) => r.targetUserId)
        .filter((id): id is number => typeof id === "number");

      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true, role: true },
          })
        : [];

      const userMap = new Map(users.map((u) => [u.id, u]));

      const topReportedUsers = topUsersRaw.map((r) => ({
        user: userMap.get(r.targetUserId as number) ?? {
          id: r.targetUserId,
          name: null,
          email: null,
          role: null,
        },
        reportCount: r._count.targetUserId,
      }));

      return res.json({
        total,
        byStatus,
        byTargetType,
        statusCountsByTargetType,
        window,
        statusCountsByTargetTypeWindow,
        created: {
          last24h: createdLast24h,
          last7d: createdLast7d,
          last30d: createdLast30d,
        },
        topReportedUsers,
      });
    } catch (err) {
      console.error("GET /admin/stats/reports error:", err);
      return res.status(500).json({
        error: "Internal server error while fetching report stats.",
      });
    }
  }
);

// POST /admin/users/:id/suspend
// Body: { reason?: string, reportId?: number }
app.post(
  "/admin/users/:id/suspend",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({
      reason: z.string().nullable().optional(),
      reportId: positiveIntSchema.optional(),
    }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: userId } = (req as any).validated.params as { id: number };
    const { reason, reportId } = (req as any).validated.body as { reason?: string | null; reportId?: number };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isSuspended: true },
    });
    if (!user) return res.status(404).json({ error: "User not found." });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspendedReason: reason?.trim() || null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: AdminActionType.USER_SUSPENDED,
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: userId,
      notes: reason?.trim() || null,
    });

    // ✅ Webhook: user suspended
    await enqueueWebhookEvent({
      eventType: "user.suspended",
      payload: {
        userId: updated.id,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        suspendedAt: updated.suspendedAt,
        suspendedReason: updated.suspendedReason,
        suspendedByAdminId: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
      },
    });

    await logSecurityEvent(req, "admin.user_suspended", {
      targetType: "USER",
      targetId: userId,
      reportId: typeof reportId === "number" ? reportId : null,
      reason: reason?.trim() || null,
    });

    return res.json({
      message: "User suspended.",
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        suspendedAt: updated.suspendedAt,
        suspendedReason: updated.suspendedReason,
      },
    });
  } catch (err) {
    console.error("POST /admin/users/:id/suspend error:", err);
    return res.status(500).json({ error: "Internal server error while suspending user." });
  }
});

// POST /admin/users/:id/unsuspend
app.post(
  "/admin/users/:id/unsuspend",
  authMiddleware,
  validate({ params: idParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: userId } = (req as any).validated.params as { id: number };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, isSuspended: true, suspendedAt: true, suspendedReason: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.isSuspended) {
      return res.status(400).json({ error: "User is not suspended" });
    }

    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          isSuspended: false,
          suspendedAt: null,
          suspendedReason: null,
        },
      }),
      prisma.adminAction.create({
        data: {
          adminId: req.user!.userId,
          type: AdminActionType.USER_UNSUSPENDED,
          entityId: userId,
          notes: "User unsuspended by admin",
        },
      }),
    ]);

    // ✅ Webhook: user unsuspended
    await enqueueWebhookEvent({
      eventType: "user.unsuspended",
      payload: {
        userId: updated.id,
        email: updated.email,
        role: updated.role,
        isSuspended: updated.isSuspended,
        unsuspendedByAdminId: req.user!.userId,
        unsuspendedAt: new Date(),
      },
    });

    await logSecurityEvent(req, "admin.user_unsuspended", {
      targetType: "USER",
      targetId: userId,
    });

    return res.json({
      message: "User unsuspended",
      user: {
        id: updated.id,
        isSuspended: updated.isSuspended,
      },
    });
  } catch (err) {
    console.error("POST /admin/users/:id/unsuspend error:", err);
    return res.status(500).json({
      error: "Internal server error while unsuspending user.",
    });
  }
});

// POST /admin/jobs/:id/hide
// Body: { reportId?: number, notes?: string }
app.post(
  "/admin/jobs/:id/hide",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({ reportId: positiveIntSchema.optional(), notes: z.string().nullable().optional() }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: jobId } = (req as any).validated.params as { id: number };
    const { reportId, notes } = (req as any).validated.body as { reportId?: number; notes?: string | null };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        consumerId: true,
        isHidden: true,
      },
    });
    if (!job) return res.status(404).json({ error: "Job not found." });

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        isHidden: true,
        hiddenAt: new Date(),
        hiddenById: req.user!.userId,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "JOB_HIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: jobId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: job hidden
    await enqueueWebhookEvent({
      eventType: "job.hidden",
      payload: {
        jobId: updated.id,
        title: updated.title,
        status: updated.status,
        location: updated.location,
        budgetMin: updated.budgetMin,
        budgetMax: updated.budgetMax,
        createdAt: updated.createdAt,
        consumerId: updated.consumerId,
        hiddenAt: updated.hiddenAt,
        hiddenById: updated.hiddenById,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    await logSecurityEvent(req, "admin.job_hidden", {
      targetType: "JOB",
      targetId: jobId,
      reportId: typeof reportId === "number" ? reportId : null,
      notes: notes?.trim() || null,
    });

    return res.json({ message: "Job hidden.", job: updated });
  } catch (err) {
    console.error("POST /admin/jobs/:id/hide error:", err);
    return res.status(500).json({ error: "Internal server error while hiding job." });
  }
});

// POST /admin/jobs/:id/unhide
app.post(
  "/admin/jobs/:id/unhide",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({ reportId: positiveIntSchema.optional(), notes: z.string().nullable().optional() }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: jobId } = (req as any).validated.params as { id: number };
    const { reportId, notes } = (req as any).validated.body as { reportId?: number; notes?: string | null };

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        title: true,
        status: true,
        location: true,
        budgetMin: true,
        budgetMax: true,
        createdAt: true,
        consumerId: true,
        isHidden: true,
        hiddenAt: true,
        hiddenById: true,
      },
    });
    if (!job) return res.status(404).json({ error: "Job not found." });

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: {
        isHidden: false,
        hiddenAt: null,
        hiddenById: null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "JOB_UNHIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: jobId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: job unhidden
    await enqueueWebhookEvent({
      eventType: "job.unhidden",
      payload: {
        jobId: updated.id,
        title: updated.title,
        status: updated.status,
        location: updated.location,
        budgetMin: updated.budgetMin,
        budgetMax: updated.budgetMax,
        createdAt: updated.createdAt,
        consumerId: updated.consumerId,
        unhiddenAt: new Date(),
        unhiddenById: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    await logSecurityEvent(req, "admin.job_unhidden", {
      targetType: "JOB",
      targetId: jobId,
      reportId: typeof reportId === "number" ? reportId : null,
      notes: notes?.trim() || null,
    });

    return res.json({ message: "Job unhidden.", job: updated });
  } catch (err) {
    console.error("POST /admin/jobs/:id/unhide error:", err);
    return res.status(500).json({ error: "Internal server error while unhiding job." });
  }
});

// POST /admin/messages/:id/hide
app.post(
  "/admin/messages/:id/hide",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({ reportId: positiveIntSchema.optional(), notes: z.string().nullable().optional() }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: messageId } = (req as any).validated.params as { id: number };
    const { reportId, notes } = (req as any).validated.body as { reportId?: number; notes?: string | null };

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        jobId: true,
        senderId: true,
        text: true,
        createdAt: true,
        isHidden: true,
      },
    });
    if (!msg) return res.status(404).json({ error: "Message not found." });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isHidden: true,
        hiddenAt: new Date(),
        hiddenById: req.user!.userId,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "MESSAGE_HIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: messageId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: message hidden
    await enqueueWebhookEvent({
      eventType: "message.hidden",
      payload: {
        messageId: updated.id,
        jobId: updated.jobId,
        senderId: updated.senderId,
        createdAt: updated.createdAt,
        hiddenAt: updated.hiddenAt,
        hiddenById: updated.hiddenById,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    await logSecurityEvent(req, "admin.message_hidden", {
      targetType: "MESSAGE",
      targetId: messageId,
      reportId: typeof reportId === "number" ? reportId : null,
      notes: notes?.trim() || null,
    });

    return res.json({ message: "Message hidden.", messageObj: updated });
  } catch (err) {
    console.error("POST /admin/messages/:id/hide error:", err);
    return res.status(500).json({ error: "Internal server error while hiding message." });
  }
});

// POST /admin/messages/:id/unhide
app.post(
  "/admin/messages/:id/unhide",
  authMiddleware,
  validate({
    params: idParamsSchema,
    body: z.object({ reportId: positiveIntSchema.optional(), notes: z.string().nullable().optional() }),
  }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { id: messageId } = (req as any).validated.params as { id: number };
    const { reportId, notes } = (req as any).validated.body as { reportId?: number; notes?: string | null };

    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        jobId: true,
        senderId: true,
        createdAt: true,
        isHidden: true,
        hiddenAt: true,
        hiddenById: true,
      },
    });
    if (!msg) return res.status(404).json({ error: "Message not found." });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isHidden: false,
        hiddenAt: null,
        hiddenById: null,
      },
    });

    await logAdminAction({
      adminId: req.user!.userId,
      type: "MESSAGE_UNHIDDEN",
      reportId: typeof reportId === "number" ? reportId : null,
      entityId: messageId,
      notes: notes?.trim() || null,
    });

    // ✅ Webhook: message unhidden
    await enqueueWebhookEvent({
      eventType: "message.unhidden",
      payload: {
        messageId: updated.id,
        jobId: updated.jobId,
        senderId: updated.senderId,
        createdAt: updated.createdAt,
        unhiddenAt: new Date(),
        unhiddenById: req.user!.userId,
        reportId: typeof reportId === "number" ? reportId : null,
        notes: notes?.trim() || null,
      },
    });

    await logSecurityEvent(req, "admin.message_unhidden", {
      targetType: "MESSAGE",
      targetId: messageId,
      reportId: typeof reportId === "number" ? reportId : null,
      notes: notes?.trim() || null,
    });

    return res.json({ message: "Message unhidden.", messageObj: updated });
  } catch (err) {
    console.error("POST /admin/messages/:id/unhide error:", err);
    return res.status(500).json({ error: "Internal server error while unhiding message." });
  }
});

// GET /admin/actions
// Query params:
//   type?: AdminActionType
//   reportId?: number
//   adminId?: number
//   page?: number (default 1)
//   pageSize?: number (default 20, max 100)
app.get(
  "/admin/actions",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const { type, reportId, adminId, page = "1", pageSize = "20" } = req.query as {
        type?: string;
        reportId?: string;
        adminId?: string;
        page?: string;
        pageSize?: string;
      };

      const pageNum = Math.max(Number(page) || 1, 1);
      const take = Math.min(Number(pageSize) || 20, 100);
      const skip = (pageNum - 1) * take;

      const where: any = {};

      if (type) where.type = type;
      const reportIdNum = Number(reportId);
      if (!Number.isNaN(reportIdNum) && reportId) where.reportId = reportIdNum;

      const adminIdNum = Number(adminId);
      if (!Number.isNaN(adminIdNum) && adminId) where.adminId = adminIdNum;

      const actions = await prisma.adminAction.findMany({
        where,
        include: {
          admin: { select: { id: true, name: true, email: true, role: true } },
          report: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      });

      const total = await prisma.adminAction.count({ where });


      return res.json({
        page: pageNum,
        pageSize: take,
        total,
        totalPages: Math.ceil(total / take) || 1,
        actions: actions.map((a) => ({
          id: a.id,
          type: a.type,
          entityId: a.entityId,
          notes: a.notes,
          createdAt: a.createdAt,
          admin: a.admin,
          reportId: a.reportId,
        })),
      });
    } catch (err) {
      console.error("GET /admin/actions error:", err);
      return res.status(500).json({ error: "Internal server error while fetching admin actions." });
    }
  }
);

// GET /admin/dashboard/overview?window=24h|7d|30d|all
app.get(
  "/admin/dashboard/overview",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      if (!requireAdmin(req, res)) return;

      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const { window = "24h" } = req.query as { window?: string };
      let windowStart: Date | null = last24h;
      if (window === "7d") windowStart = last7d;
      if (window === "30d") windowStart = last30d;
      if (window === "all") windowStart = null;

      const windowWhere = windowStart ? { createdAt: { gte: windowStart } } : {};

      // --- Report stats (same logic as /admin/stats/reports) ---
      const total = await prisma.report.count();

      const byStatusRaw = await prisma.report.groupBy({
        by: ["status"],
        _count: { _all: true },
      });

      const byStatus = {
        OPEN: 0,
        IN_REVIEW: 0,
        RESOLVED: 0,
        DISMISSED: 0,
      } as Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>;

      for (const row of byStatusRaw) {
        byStatus[row.status as keyof typeof byStatus] = row._count._all;
      }

      const byTypeRaw = await prisma.report.groupBy({
        by: ["targetType"],
        _count: { _all: true },
      });

      const byTargetType = {
        USER: 0,
        JOB: 0,
        MESSAGE: 0,
      } as Record<"USER" | "JOB" | "MESSAGE", number>;

      for (const row of byTypeRaw) {
        byTargetType[row.targetType as keyof typeof byTargetType] = row._count._all;
      }

      const byTypeStatusRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        _count: { _all: true },
      });

      const statusCountsByTargetType: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetType[t][s] = row._count._all;
      }

      const byTypeStatusWindowRaw = await prisma.report.groupBy({
        by: ["targetType", "status"],
        where: windowWhere,
        _count: { _all: true },
      });

      const statusCountsByTargetTypeWindow: Record<
        "USER" | "JOB" | "MESSAGE",
        Record<"OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED", number>
      > = {
        USER: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        JOB: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
        MESSAGE: { OPEN: 0, IN_REVIEW: 0, RESOLVED: 0, DISMISSED: 0 },
      };

      for (const row of byTypeStatusWindowRaw) {
        const t = row.targetType as "USER" | "JOB" | "MESSAGE";
        const s = row.status as "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
        statusCountsByTargetTypeWindow[t][s] = row._count._all;
      }

      const [createdLast24h, createdLast7d, createdLast30d] =
        await prisma.$transaction([
          prisma.report.count({ where: { createdAt: { gte: last24h } } }),
          prisma.report.count({ where: { createdAt: { gte: last7d } } }),
          prisma.report.count({ where: { createdAt: { gte: last30d } } }),
        ]);

      // --- Recent reports (10) ---
      const recentReports = await prisma.report.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          reporter: { select: { id: true, name: true, email: true, role: true } },
          handledByAdmin: { select: { id: true, name: true, email: true, role: true } },
        },
      });

      // --- Recent admin actions (10) ---
      const recentActions = await prisma.adminAction.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          admin: { select: { id: true, name: true, email: true, role: true } },
        },
      });

      // --- Moderation counts ---
      const [suspendedUsers, hiddenJobs, hiddenMessages] = await prisma.$transaction([
        prisma.user.count({ where: { isSuspended: true } }),
        prisma.job.count({ where: { isHidden: true } }),
        prisma.message.count({ where: { isHidden: true } }),
      ]);

      return res.json({
        window,
        reports: {
          total,
          byStatus,
          byTargetType,
          statusCountsByTargetType,
          statusCountsByTargetTypeWindow,
          created: {
            last24h: createdLast24h,
            last7d: createdLast7d,
            last30d: createdLast30d,
          },
        },
        moderation: {
          suspendedUsers,
          hiddenJobs,
          hiddenMessages,
        },
        recentReports: recentReports.map((r) => ({
          id: r.id,
          targetType: r.targetType,
          status: r.status,
          reason: r.reason,
          createdAt: r.createdAt,
          reporter: r.reporter,
          handledByAdmin: r.handledByAdmin,
          handledAt: r.handledAt,
        })),
        recentActions: recentActions.map((a) => ({
          id: a.id,
          type: a.type,
          entityId: a.entityId,
          notes: a.notes,
          createdAt: a.createdAt,
          admin: a.admin,
          reportId: a.reportId,
        })),
      });
    } catch (err) {
      console.error("GET /admin/dashboard/overview error:", err);
      return res.status(500).json({ error: "Internal server error while fetching admin overview." });
    }
  }
);


// POST /admin/impersonate/stop
// IMPORTANT: Call this USING THE IMPERSONATION TOKEN (not the real admin token).
app.post("/admin/impersonate/stop", authMiddleware, validate({}), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });

    // This endpoint is ONLY for impersonated sessions
    if (!req.user.isImpersonated || !req.user.impersonatedByAdminId) {
      return res.status(400).json({ error: "Not currently impersonating." });
    }

    const adminId = req.user.impersonatedByAdminId; // real admin who started impersonation
    const targetUserId = req.user.userId; // user being impersonated

    await prisma.adminAction.create({
      data: {
        adminId,
        type: AdminActionType.ADMIN_IMPERSONATION_STOPPED,
        entityId: targetUserId,
        notes: `Impersonation stopped for userId=${targetUserId}`,
      },
    });

    // ✅ Webhook: impersonation stopped
    await enqueueWebhookEvent({
      eventType: "admin.impersonation_stopped",
      payload: {
        adminId,
        targetUserId,
        stoppedAt: new Date(),
      },
    });

    await logSecurityEvent(req, "admin.impersonation_stopped", {
      actorUserId: adminId,
      actorRole: "ADMIN",
      targetType: "USER",
      targetId: targetUserId,
      impersonatedUserId: targetUserId,
    });

    return res.json({
      message: "Impersonation stopped (logged). Discard the impersonation token and use the original admin token.",
    });
  } catch (err) {
    console.error("Admin impersonate stop error:", err);
    return res.status(500).json({ error: "Internal server error while stopping impersonation." });
  }
});

// POST /admin/impersonate/:userId
app.post(
  "/admin/impersonate/:userId(\\d+)",
  authMiddleware,
  validate({ params: userIdParamsSchema }),
  async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { userId: targetUserId } = (req as any).validated.params as { userId: number };

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, email: true, isSuspended: true },
    });

    if (!target) return res.status(404).json({ error: "Target user not found." });

    if (target.role === "ADMIN") {
      return res.status(400).json({ error: "Cannot impersonate an ADMIN user." });
    }

    const adminId = req.user!.userId;

    const token = jwt.sign(
      {
        userId: target.id,
        role: target.role,
        isImpersonated: true,
        impersonatedByAdminId: adminId,
      },
      process.env.JWT_SECRET as string,
      { expiresIn: "30m" }
    );

    await prisma.adminAction.create({
      data: {
        adminId,
        type: AdminActionType.ADMIN_IMPERSONATION_STARTED,
        entityId: target.id,
        notes: `Impersonation started for userId=${target.id} (${target.email}). Suspended=${target.isSuspended}`,
      },
    });

    // ✅ Webhook: impersonation started
    await enqueueWebhookEvent({
      eventType: "admin.impersonation_started",
      payload: {
        adminId,
        targetUserId: target.id,
        targetEmail: target.email,
        targetRole: target.role,
        targetIsSuspended: target.isSuspended,
        startedAt: new Date(),
        expiresIn: "30m",
      },
    });

    await logSecurityEvent(req, "admin.impersonation_started", {
      targetType: "USER",
      targetId: target.id,
      targetRole: target.role,
      targetIsSuspended: target.isSuspended,
      expiresIn: "30m",
    });

    return res.json({
      message: "Impersonation token issued.",
      token,
      target: {
        id: target.id,
        role: target.role,
        email: target.email,
        isSuspended: target.isSuspended,
      },
      expiresIn: "30m",
    });
  } catch (err) {
    console.error("Admin impersonate start error:", err);
    return res.status(500).json({ error: "Internal server error while starting impersonation." });
  }
});

const DELIVERY_INTERVAL_MS = 3000;
const DELIVERY_TIMEOUT_MS = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS ?? 5000);
const WEBHOOK_MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5);

// GET /admin/webhooks/deliveries
// Supports filters + cursor pagination
// Query params:
//   status=FAILED|PENDING|PROCESSING|SUCCESS
//   endpointId=9
//   event=webhook.test (partial match)
//   take=50 (max 100)
//   cursor=123 (delivery id)
// GET /admin/webhooks/deliveries
app.get("/admin/webhooks/deliveries", authMiddleware, async (req: AuthRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  try {
    if (!requireAdmin(req, res)) return;

    const takeRaw = Number(req.query.take ?? 50);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 50;

    const cursorRaw = req.query.cursor;
    const cursor = cursorRaw !== undefined ? Number(cursorRaw) : undefined;
    const hasCursor = Number.isFinite(cursor);

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const endpointIdRaw = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
    const endpointId = endpointIdRaw ? Number(endpointIdRaw) : undefined;
    const event = typeof req.query.event === "string" ? req.query.event : undefined;

    const where: any = {};
    if (status) where.status = status;
    if (Number.isFinite(endpointId)) where.endpointId = endpointId;
    if (event) where.event = { contains: event, mode: "insensitive" };

    const deliveries = await prisma.webhookDelivery.findMany({
      where,
      take,
      ...(hasCursor ? { skip: 1, cursor: { id: cursor as number } } : {}),
      orderBy: { id: "desc" },
      include: {
        endpoint: {
          select: {
            id: true,
            url: true,
            events: true,
            enabled: true,
            // ❌ removed: name (doesn't exist in your schema)
          },
        },
      },
    });

    const items = deliveries.map((d) => {
      const payload = d.payload as any;

      return {
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,

        // ✅ observability fields (no any-casts needed)
        lastStatusCode: d.lastStatusCode ?? null,
        lastAttemptAt: d.lastAttemptAt ?? null,
        deliveredAt: d.deliveredAt ?? null,
        nextAttempt: d.nextAttempt ?? null,

        endpoint: {
          id: d.endpoint.id,
          url: d.endpoint.url,
          enabled: d.endpoint.enabled,
          subscribedEvents: d.endpoint.events,
        },

        context: {
          jobId: payload?.jobId ?? payload?.job?.id ?? null,
          jobTitle: payload?.title ?? payload?.job?.title ?? null,
          userId: payload?.userId ?? payload?.consumerId ?? payload?.providerId ?? null,
        },

        payload,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
    });

    return res.json({
      items,
      nextCursor: items.length === take ? items[items.length - 1].id : null,
    });
  } catch (err) {
    console.error("List webhook deliveries error:", err);
    return res.status(500).json({
      error: "Internal server error listing webhook deliveries.",
    });
  }
});

// GET /admin/webhooks/deliveries/:id
// Returns the delivery + endpoint + attemptLogs (latest 200)
app.get("/admin/webhooks/deliveries/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid delivery id." });
    }

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id },
      include: {
        endpoint: {
          select: {
            id: true,
            url: true,
            events: true,
            enabled: true,
            // ❌ removed: name (doesn't exist in your schema)
          },
        },
        attemptLogs: {
          orderBy: [{ attemptNumber: "asc" }, { startedAt: "asc" }],
          take: 200,
        },
      },
    });

    if (!delivery) {
      return res.status(404).json({ error: "Webhook delivery not found." });
    }

    const payload = delivery.payload as any;

    return res.json({
      id: delivery.id,
      event: delivery.event,
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.lastError,

      lastStatusCode: delivery.lastStatusCode ?? null,
      lastAttemptAt: delivery.lastAttemptAt ?? null,
      deliveredAt: delivery.deliveredAt ?? null,
      nextAttempt: delivery.nextAttempt ?? null,

      endpoint: {
        id: delivery.endpoint.id,
        url: delivery.endpoint.url,
        enabled: delivery.endpoint.enabled,
        subscribedEvents: delivery.endpoint.events,
      },

      context: {
        jobId: payload?.jobId ?? payload?.job?.id ?? null,
        jobTitle: payload?.title ?? payload?.job?.title ?? null,
        userId: payload?.userId ?? payload?.consumerId ?? payload?.providerId ?? null,
      },

      payload,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,

      attemptLogs: delivery.attemptLogs,
    });
  } catch (err) {
    console.error("Get webhook delivery error:", err);
    return res.status(500).json({
      error: "Internal server error fetching webhook delivery.",
    });
  }
});

// GET /admin/webhooks/ui
// Lightweight admin dashboard (no separate frontend).
// It expects an Admin JWT in localStorage under "adminToken".
const requireAdminUiEnabled = createRequireAdminUiEnabled(process.env);
const basicAuthForAdminUi = createBasicAuthForAdminUi(process.env);

// GET /admin/ops/ui
// Lightweight admin ops dashboard (no separate frontend).
// It expects an Admin JWT in localStorage under "adminToken".
app.get(
  "/admin/ops/ui",
  // Gate the route entirely (returns 404 when disabled).
  requireAdminUiEnabled,
  // Clickjacking protections (explicit for this HTML route)
  helmet.frameguard({ action: "deny" }),
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
    },
  }),
  basicAuthForAdminUi,
  async (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ops Admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    input, select, button, textarea { padding: 8px; font-size: 14px; }
    button { cursor: pointer; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 8px; font-size: 13px; vertical-align: top; }
    tr:hover { background: #fafafa; }
    tr.attn { background: #fff7ed; }
    tr.attn:hover { background: #ffedd5; }
    .muted { color: #666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid #ddd; }
    .ok { border-color: #9ae6b4; }
    .bad { border-color: #feb2b2; }
    .warn { border-color: #fbd38d; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .small { font-size: 12px; padding: 6px 8px; }
  </style>
</head>
<body>
  <h2>Ops Admin</h2>
  <p class="muted" style="margin-top: -6px;">Quick triage: flagged content, disputes, webhook failures, KPIs. <a href="/admin/webhooks/ui">Webhooks UI</a></p>

  <div class="card">
    <div class="row">
      <label>
        Admin Token (JWT)
        <input id="token" placeholder="paste admin token here" style="min-width:420px" />
      </label>
      <label>
        Window (days)
        <input id="windowDays" value="30" style="width:100px" />
      </label>
      <button id="saveToken">Save Token</button>
      <button id="refreshAll">Refresh All</button>
    </div>
    <p class="muted" style="margin:10px 0 0;">
      Requests send <span class="mono">Authorization: Bearer &lt;token&gt;</span>.
    </p>
  </div>

  <div class="grid">
    <div class="card">
      <h3 style="margin-top:0;">KPIs</h3>
      <div id="kpis" class="muted">Click “Refresh All”.</div>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Recent webhook failures</h3>
      <div class="actions" style="margin-bottom:8px;">
        <button class="small" id="refreshWebhooks">Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Event</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody id="webhookFailures"></tbody>
      </table>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3 style="margin-top:0;">Flagged queue (reports)</h3>
      <div class="actions" style="margin-bottom:8px;">
        <button class="small" id="refreshFlagged">Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Target</th>
            <th>Reason</th>
            <th>Reporter</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="flagged"></tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Disputes queue</h3>
      <div class="actions" style="margin-bottom:8px;">
        <button class="small" id="refreshDisputes">Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Job</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Opened</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="disputes"></tbody>
      </table>
    </div>
  </div>

<script>
  console.log("[admin ops ui] script loaded");

  const tokenEl = document.getElementById("token");
  const windowDaysEl = document.getElementById("windowDays");
  const kpisEl = document.getElementById("kpis");
  const webhookFailuresEl = document.getElementById("webhookFailures");
  const flaggedEl = document.getElementById("flagged");
  const disputesEl = document.getElementById("disputes");

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  function getToken() {
    const typed = (tokenEl.value || "").trim();
    if (typed) return typed;
    return (localStorage.getItem("adminToken") || "").trim();
  }

  async function api(method, path, body) {
    const token = getToken();
    if (!token) throw new Error("Missing admin token");
    const r = await fetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + token,
        "cache-control": "no-store",
        "pragma": "no-cache",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(r.status + " " + text);
    return text ? JSON.parse(text) : null;
  }

  function pill(status) {
    const cls = (status === "SUCCESS") ? "ok" : (status === "FAILED") ? "bad" : (status === "OPEN" || status === "INVESTIGATING") ? "warn" : "";
    return "<span class='pill " + cls + "'>" + escapeHtml(status) + "</span>";
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && Number.isFinite(n);
  }

  function fmtPercent(rate) {
    if (!isFiniteNumber(rate)) return "n/a";
    return (Math.round(rate * 1000) / 10) + "%";
  }

  let lastChurnCsv = "";

  function toCsvCell(v) {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    return false;
  }

  async function refreshKpis() {
    const windowDays = Number(windowDaysEl.value || 30);
    kpisEl.innerHTML = "<div class='muted'>Loading…</div>";
    const d = await api("GET", "/admin/ops/kpis?windowDays=" + encodeURIComponent(windowDays), null);
    const conv = d.postToAwardConversion?.conversion;

    const churned = d.churnByTier?.churnedByTier || {};
    const active = d.churnByTier?.activePaidByTier || {};
    const expiringSoon = d.churnByTier?.expiringSoonByTier || {};
    const payments = d.churnByTier?.successfulSubscriptionPaymentsByTier || {};
    const churnRate = d.churnByTier?.churnRateByTier || {};

    const tiers = Array.from(new Set(
      []
        .concat(Object.keys(active || {}))
        .concat(Object.keys(churned || {}))
        .concat(Object.keys(expiringSoon || {}))
        .concat(Object.keys(payments || {}))
        .concat(Object.keys(churnRate || {}))
    ));

    tiers.sort((a, b) => {
      const ar = isFiniteNumber(churnRate?.[a]) ? churnRate[a] : -1;
      const br = isFiniteNumber(churnRate?.[b]) ? churnRate[b] : -1;
      if (br !== ar) return br - ar;
      const ae = isFiniteNumber(expiringSoon?.[a]) ? expiringSoon[a] : 0;
      const be = isFiniteNumber(expiringSoon?.[b]) ? expiringSoon[b] : 0;
      if (be !== ae) return be - ae;
      return String(a).localeCompare(String(b));
    });

    const churnRows = tiers.map((tier) => {
      const a = isFiniteNumber(active?.[tier]) ? active[tier] : 0;
      const c = isFiniteNumber(churned?.[tier]) ? churned[tier] : 0;
      const e = isFiniteNumber(expiringSoon?.[tier]) ? expiringSoon[tier] : 0;
      const p = isFiniteNumber(payments?.[tier]) ? payments[tier] : 0;
      const r = churnRate?.[tier];
      const cls = e > 0 ? "attn" : "";
      return "<tr class='" + cls + "'>" +
        "<td class='mono'>" + escapeHtml(tier) + "</td>" +
        "<td>" + escapeHtml(a) + "</td>" +
        "<td>" + escapeHtml(c) + "</td>" +
        "<td>" + escapeHtml(e) + "</td>" +
        "<td>" + escapeHtml(p) + "</td>" +
        "<td>" + escapeHtml(fmtPercent(r)) + "</td>" +
      "</tr>";
    }).join("") || "<tr><td colspan='6' class='muted'>(no subscription data)</td></tr>";

    lastChurnCsv = "" +
      [
        ["tier", "active", "expiredWithinWindow", "expiringSoon7d", "subscriptionPaymentsWindow", "approxChurnRate"].map(toCsvCell).join(","),
      ].concat(tiers.map((tier) => {
        const a = isFiniteNumber(active?.[tier]) ? active[tier] : 0;
        const c = isFiniteNumber(churned?.[tier]) ? churned[tier] : 0;
        const e = isFiniteNumber(expiringSoon?.[tier]) ? expiringSoon[tier] : 0;
        const p = isFiniteNumber(payments?.[tier]) ? payments[tier] : 0;
        const r = churnRate?.[tier];
        return [tier, a, c, e, p, (isFiniteNumber(r) ? r : "")].map(toCsvCell).join(",");
      })).join("\n");

    const churnTable = "" +
      "<div style='margin-top:6px; display:flex; align-items:center; justify-content:space-between; gap:8px;'>" +
        "<b>Churn by tier</b>" +
        "<div class='actions'><button class='small' id='copyChurnCsv'>Copy churn CSV</button></div>" +
      "</div>" +
      "<div class='muted' style='margin-top:4px; font-size:12px;'>" +
        "Rows highlighted when <span class='mono'>expiringSoon(7d)</span> &gt; 0." +
      "</div>" +
      "<table style='margin-top:6px;'>" +
        "<thead><tr>" +
          "<th>Tier</th>" +
          "<th>Active</th>" +
          "<th>Expired (window)</th>" +
          "<th>Expiring soon (7d)</th>" +
          "<th>Payments (window)</th>" +
          "<th>Approx churn rate</th>" +
        "</tr></thead>" +
        "<tbody>" + churnRows + "</tbody>" +
      "</table>";

    kpisEl.innerHTML = "" +
      "<div><b>Time to first bid</b>: avg " + escapeHtml(d.timeToFirstBid?.avgMinutes) + "m, p50 " + escapeHtml(d.timeToFirstBid?.p50Minutes) + "m, p90 " + escapeHtml(d.timeToFirstBid?.p90Minutes) + "m (" + escapeHtml(d.timeToFirstBid?.jobsWithAtLeastOneBid) + "/" + escapeHtml(d.timeToFirstBid?.sampledJobs) + " jobs)</div>" +
      "<div style='margin-top:6px;'><b>Post→Award conversion</b>: " + (conv == null ? "n/a" : (Math.round(conv * 1000)/10 + "%")) + " (" + escapeHtml(d.postToAwardConversion?.jobsAwarded) + "/" + escapeHtml(d.postToAwardConversion?.jobsPosted) + ")</div>" +
      "<div style='margin-top:6px;'><b>Report rate</b>: " + (d.reportRate?.per100JobsPosted == null ? "n/a" : (Math.round(d.reportRate.per100JobsPosted * 10)/10 + " per 100 jobs")) + ", " + (d.reportRate?.per1000MessagesCreated == null ? "n/a" : (Math.round(d.reportRate.per1000MessagesCreated * 10)/10 + " per 1000 messages")) + "</div>" +
      churnTable +
      "<div class='muted' style='margin-top:6px; font-size:12px;'>" + escapeHtml(d.churnByTier?.churnDefinition || "") + "</div>";
  }

  async function refreshWebhookFailures() {
    webhookFailuresEl.innerHTML = "<tr><td colspan='5' class='muted'>Loading…</td></tr>";
    const d = await api("GET", "/admin/ops/webhook-failures?take=50", null);
    const rows = (d.items || []).map((x) => {
      return "<tr>" +
        "<td class='mono'>" + escapeHtml(x.id) + "</td>" +
        "<td class='mono'>" + escapeHtml(x.event) + "</td>" +
        "<td>" + pill(x.status) + "</td>" +
        "<td>" + escapeHtml(x.attempts) + "</td>" +
        "<td class='muted'>" + escapeHtml((x.lastError || "").slice(0, 160)) + "</td>" +
      "</tr>";
    }).join("");
    webhookFailuresEl.innerHTML = rows || "<tr><td colspan='5' class='muted'>(none)</td></tr>";
  }

  async function refreshFlagged() {
    flaggedEl.innerHTML = "<tr><td colspan='6' class='muted'>Loading…</td></tr>";
    const d = await api("GET", "/admin/ops/flagged?take=50&status=OPEN", null);
    const rows = (d.items || []).map((r) => {
      const target = r.targetType + ": " + (r.targetUser?.id || r.targetJob?.id || r.targetMessage?.id || "?");
      const actions = [];
      if (r.targetUser?.id) actions.push("<button class='small' data-act='suspend-user' data-user='" + r.targetUser.id + "' data-report='" + r.id + "'>Suspend user</button>");
      if (r.targetJob?.id) actions.push("<button class='small' data-act='hide-job' data-job='" + r.targetJob.id + "' data-report='" + r.id + "'>Hide job</button>");
      if (r.targetMessage?.id) actions.push("<button class='small' data-act='hide-message' data-msg='" + r.targetMessage.id + "' data-report='" + r.id + "'>Hide msg</button>");
      actions.push("<button class='small' data-act='mark-review' data-report='" + r.id + "'>Mark IN_REVIEW</button>");
      actions.push("<button class='small' data-act='dismiss' data-report='" + r.id + "'>Dismiss</button>");
      return "<tr>" +
        "<td class='mono'>" + escapeHtml(r.id) + "</td>" +
        "<td>" + escapeHtml(target) + "</td>" +
        "<td>" + escapeHtml(r.reason || "") + "</td>" +
        "<td class='muted'>" + escapeHtml(r.reporter?.email || r.reporter?.name || "") + "</td>" +
        "<td class='muted'>" + escapeHtml(new Date(r.createdAt).toLocaleString()) + "</td>" +
        "<td><div class='actions'>" + actions.join("") + "</div></td>" +
      "</tr>";
    }).join("");
    flaggedEl.innerHTML = rows || "<tr><td colspan='6' class='muted'>(none)</td></tr>";
  }

  async function refreshDisputes() {
    disputesEl.innerHTML = "<tr><td colspan='6' class='muted'>Loading…</td></tr>";
    const d = await api("GET", "/admin/ops/disputes?take=50", null);
    const rows = (d.items || []).map((x) => {
      return "<tr>" +
        "<td class='mono'>" + escapeHtml(x.id) + "</td>" +
        "<td class='mono'>" + escapeHtml(x.jobId) + (x.jobTitle ? (" — " + escapeHtml(x.jobTitle)) : "") + "</td>" +
        "<td>" + pill(x.status) + "</td>" +
        "<td>" + escapeHtml(x.reasonCode || "") + "</td>" +
        "<td class='muted'>" + escapeHtml(new Date(x.createdAt).toLocaleString()) + "</td>" +
        "<td><div class='actions'><button class='small' data-act='resolve-dispute' data-dispute='" + x.id + "'>Resolve…</button></div></td>" +
      "</tr>";
    }).join("");
    disputesEl.innerHTML = rows || "<tr><td colspan='6' class='muted'>(none)</td></tr>";
  }

  document.getElementById("saveToken").addEventListener("click", () => {
    const t = (tokenEl.value || "").trim();
    if (!t) { alert("Paste a token first."); return; }
    localStorage.setItem("adminToken", t);
    alert("Saved.");
  });

  document.getElementById("refreshAll").addEventListener("click", async () => {
    try {
      await Promise.all([refreshKpis(), refreshWebhookFailures(), refreshFlagged(), refreshDisputes()]);
    } catch (e) {
      alert(String(e?.message || e));
      console.error(e);
    }
  });
  document.getElementById("refreshWebhooks").addEventListener("click", () => refreshWebhookFailures().catch((e) => alert(String(e))));
  document.getElementById("refreshFlagged").addEventListener("click", () => refreshFlagged().catch((e) => alert(String(e))));
  document.getElementById("refreshDisputes").addEventListener("click", () => refreshDisputes().catch((e) => alert(String(e))));

  kpisEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    if (btn.id !== "copyChurnCsv") return;
    if (!lastChurnCsv) {
      alert("No churn data yet. Click Refresh All first.");
      return;
    }
    const ok = await copyTextToClipboard(lastChurnCsv);
    if (ok) {
      alert("Copied churn CSV.");
      return;
    }
    prompt("Copy churn CSV:", lastChurnCsv);
  });

  flaggedEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    try {
      if (act === "suspend-user") {
        const userId = Number(btn.getAttribute("data-user"));
        const reportId = Number(btn.getAttribute("data-report"));
        const reason = prompt("Suspend reason (optional):", "");
        await api("POST", "/admin/users/" + userId + "/suspend", { reason: reason || null, reportId });
        alert("User suspended.");
        await refreshFlagged();
      } else if (act === "hide-job") {
        const jobId = Number(btn.getAttribute("data-job"));
        const reportId = Number(btn.getAttribute("data-report"));
        const notes = prompt("Notes (optional):", "");
        await api("POST", "/admin/jobs/" + jobId + "/hide", { reportId, notes: notes || null });
        alert("Job hidden.");
        await refreshFlagged();
      } else if (act === "hide-message") {
        const msgId = Number(btn.getAttribute("data-msg"));
        const reportId = Number(btn.getAttribute("data-report"));
        const notes = prompt("Notes (optional):", "");
        await api("POST", "/admin/messages/" + msgId + "/hide", { reportId, notes: notes || null });
        alert("Message hidden.");
        await refreshFlagged();
      } else if (act === "mark-review") {
        const reportId = Number(btn.getAttribute("data-report"));
        await api("PATCH", "/admin/reports/" + reportId, { status: "IN_REVIEW" });
        await refreshFlagged();
      } else if (act === "dismiss") {
        const reportId = Number(btn.getAttribute("data-report"));
        const note = prompt("Dismiss note (optional):", "");
        await api("PATCH", "/admin/reports/" + reportId, { status: "DISMISSED", adminNotes: note || null });
        await refreshFlagged();
      }
    } catch (e) {
      alert(String(e?.message || e));
      console.error(e);
    }
  });

  disputesEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act !== "resolve-dispute") return;
    const disputeId = Number(btn.getAttribute("data-dispute"));
    try {
      const jobStatus = prompt("Resolve dispute → set job status to COMPLETED or CANCELLED:", "COMPLETED");
      if (!jobStatus) return;
      const resolutionNotes = prompt("Resolution notes (required):", "");
      if (!resolutionNotes || !resolutionNotes.trim()) { alert("Resolution notes required."); return; }
      await api("POST", "/admin/disputes/" + disputeId + "/resolve", { jobStatus, resolutionNotes });
      alert("Dispute resolved.");
      await refreshDisputes();
    } catch (e) {
      alert(String(e?.message || e));
      console.error(e);
    }
  });
</script>
</body>
</html>`);
  }
);

// --- Admin Ops JSON endpoints (admin-only) ---
app.get("/admin/ops/kpis", authMiddleware, createGetAdminOpsKpisHandler({ prisma }));

// GET /admin/ops/flagged
// Query: status=OPEN|IN_REVIEW|RESOLVED|DISMISSED (default OPEN), type=USER|JOB|MESSAGE, take (default 50, max 100)
app.get("/admin/ops/flagged", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const takeRaw = Number(req.query.take ?? 50);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 50;
    const status = typeof req.query.status === "string" ? req.query.status : "OPEN";
    const type = typeof req.query.type === "string" ? req.query.type : undefined;

    const where: any = {};
    if (["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(status)) where.status = status;
    if (type && ["USER", "JOB", "MESSAGE"].includes(type)) where.targetType = type;

    const reports = await prisma.report.findMany({
      where,
      take,
      orderBy: { createdAt: "desc" },
      include: { reporter: true, targetUser: true, targetJob: true, targetMessage: true },
    });

    return res.json({
      items: reports.map((r: any) => ({
        id: r.id,
        targetType: r.targetType,
        status: r.status,
        reason: r.reason,
        details: r.details,
        adminNotes: r.adminNotes,
        createdAt: r.createdAt,
        reporter: r.reporter
          ? { id: r.reporter.id, name: r.reporter.name, email: r.reporter.email, role: r.reporter.role }
          : null,
        targetUser: r.targetUser
          ? { id: r.targetUser.id, name: r.targetUser.name, email: r.targetUser.email, role: r.targetUser.role }
          : null,
        targetJob: r.targetJob ? { id: r.targetJob.id, title: r.targetJob.title, consumerId: r.targetJob.consumerId } : null,
        targetMessage: r.targetMessage
          ? { id: r.targetMessage.id, jobId: r.targetMessage.jobId, senderId: r.targetMessage.senderId, text: r.targetMessage.text }
          : null,
      })),
    });
  } catch (err) {
    console.error("GET /admin/ops/flagged error:", err);
    return res.status(500).json({ error: "Internal server error while fetching flagged queue." });
  }
});

// GET /admin/ops/disputes
// Default queue: OPEN + INVESTIGATING
app.get("/admin/ops/disputes", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const takeRaw = Number(req.query.take ?? 50);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 50;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const where: any = {};
    if (status && ["OPEN", "INVESTIGATING", "RESOLVED"].includes(status)) {
      where.status = status;
    } else {
      where.status = { in: ["OPEN", "INVESTIGATING"] };
    }

    const disputes = await prisma.dispute.findMany({
      where,
      take,
      orderBy: { createdAt: "desc" },
      include: {
        job: { select: { id: true, title: true, status: true, consumerId: true, awardedProviderId: true } },
        openedBy: { select: { id: true, email: true, role: true, name: true } },
      },
    });

    return res.json({
      items: disputes.map((d: any) => ({
        id: d.id,
        jobId: d.jobId,
        jobTitle: d.job?.title ?? null,
        jobStatus: d.job?.status ?? null,
        openedByUserId: d.openedByUserId,
        openedBy: d.openedBy,
        reasonCode: d.reasonCode,
        status: d.status,
        createdAt: d.createdAt,
        resolvedAt: d.resolvedAt,
      })),
    });
  } catch (err) {
    console.error("GET /admin/ops/disputes error:", err);
    return res.status(500).json({ error: "Internal server error while fetching disputes queue." });
  }
});

// GET /admin/ops/webhook-failures
app.get("/admin/ops/webhook-failures", authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!requireAdmin(req, res)) return;

    const takeRaw = Number(req.query.take ?? 50);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 50;

    const failures = await prisma.webhookDelivery.findMany({
      where: { status: "FAILED" },
      take,
      orderBy: { id: "desc" },
      select: {
        id: true,
        event: true,
        status: true,
        attempts: true,
        lastError: true,
        lastStatusCode: true,
        lastAttemptAt: true,
        nextAttempt: true,
        createdAt: true,
        endpoint: { select: { id: true, url: true, enabled: true } },
      },
    });

    return res.json({ items: failures });
  } catch (err) {
    console.error("GET /admin/ops/webhook-failures error:", err);
    return res.status(500).json({ error: "Internal server error while fetching webhook failures." });
  }
});

app.get(
  "/admin/webhooks/ui",
  // Gate the route entirely (returns 404 when disabled).
  requireAdminUiEnabled,
  // Clickjacking protections (explicit for this HTML route)
  helmet.frameguard({ action: "deny" }),
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
    },
  }),
  basicAuthForAdminUi,
  async (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Webhooks Admin</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 16px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    input, select, button, textarea { padding: 8px; font-size: 14px; }
    button { cursor: pointer; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #eee; padding: 8px; font-size: 13px; vertical-align: top; }
    tr:hover { background: #fafafa; }
    .muted { color: #666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid #ddd; }
    .ok { border-color: #9ae6b4; }
    .bad { border-color: #feb2b2; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: #f7f7f7; padding: 10px; border-radius: 8px; }
  </style>
</head>
<body>
  <h2>Webhooks Admin</h2>

  <div class="card">
    <div class="row">
      <label>
        Admin Token (JWT)
        <input id="token" placeholder="paste admin token here" style="min-width:420px" />
      </label>

      <label>
        Status
        <select id="status">
          <option value="">(any)</option>
          <option value="PENDING">PENDING</option>
          <option value="PROCESSING">PROCESSING</option>
          <option value="SUCCESS">SUCCESS</option>
          <option value="FAILED">FAILED</option>
        </select>
      </label>

      <label>
        Endpoint ID
        <input id="endpointId" placeholder="e.g. 9" style="width:120px" />
      </label>

      <label>
        Event contains
        <input id="event" placeholder="e.g. webhook.test" style="width:220px" />
      </label>

      <button id="saveToken">Save Token</button>
      <button id="refresh">Refresh</button>
      <button id="loadMore">Load more</button>
    </div>

    <p class="muted" style="margin:10px 0 0;">
      Tip: token is stored locally in your browser. Requests send <span class="mono">Authorization: Bearer &lt;token&gt;</span>.
    </p>
  </div>

  <div class="grid">
    <div class="card">
      <h3 style="margin-top:0;">Deliveries</h3>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Event</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Last</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody id="deliveries"></tbody>
      </table>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Delivery details</h3>
      <div id="detail" class="muted">Click a delivery on the left.</div>
    </div>
  </div>

<script>
  // ✅ quick sanity check: if you don't see this, script isn't running
  console.log("[admin webhooks ui] script loaded");

  const tokenEl = document.getElementById("token");
  const statusEl = document.getElementById("status");
  const endpointIdEl = document.getElementById("endpointId");
  const eventEl = document.getElementById("event");
  const deliveriesEl = document.getElementById("deliveries"); // TBODY
  const detailEl = document.getElementById("detail");

  let nextCursor = null;

  function getToken() {
    const typed = (tokenEl.value || "").trim();
    if (typed) return typed;
    return (localStorage.getItem("adminToken") || "").trim();
  }

  function qs(params) {
    const u = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && String(v).length) u.set(k, String(v));
    });
    const s = u.toString();
    return s ? "?" + s : "";
  }

  function short(s) {
    s = String(s || "");
    return s.length > 60 ? s.slice(0, 60) + "…" : s;
  }

  // ✅ FIXED: this version will not crash parsing
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  function statusPill(status) {
    const cls = (status === "SUCCESS") ? "ok" : (status === "FAILED") ? "bad" : "";
    return "<span class='pill " + cls + "'>" + escapeHtml(status) + "</span>";
  }

  async function fetchDeliveryDetail(id) {
  const token = getToken();
  if (!token) {
    alert("Paste your admin token first, click Save Token, then click Refresh.");
    return;
  }

  detailEl.innerHTML = "<div class='muted'>Loading detail…</div>";

  const r = await fetch("/admin/webhooks/deliveries/" + encodeURIComponent(id), {
    method: "GET",
    cache: "no-store",
    headers: {
      "Authorization": "Bearer " + token,
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  if (r.status === 304) return;

  if (!r.ok) {
    const text = await r.text();
    console.error("Delivery detail fetch failed:", r.status, text);
    detailEl.innerHTML =
      "<div class='muted'>Failed to load detail (" + r.status + ")</div>" +
      "<pre>" + escapeHtml(text) + "</pre>";
    return;
  }

  const d = await r.json();

  const endpointLine =
    (d.endpoint?.id ?? "") +
    (d.endpoint?.url ? (" — " + d.endpoint.url) : "") +
    (d.endpoint?.enabled === false ? " (disabled)" : "");

  const contextLine = [
    d.context?.jobId ? ("jobId: " + d.context.jobId) : null,
    d.context?.jobTitle ? ("title: " + d.context.jobTitle) : null,
    d.context?.userId ? ("userId: " + d.context.userId) : null,
  ].filter(Boolean).join(" | ");

  const attempts = Array.isArray(d.attemptLogs) ? d.attemptLogs : [];

  const attemptRows = attempts.length
    ? (
      "<table style='width:100%;border-collapse:collapse;margin-top:8px'>" +
        "<thead><tr>" +
          "<th style='text-align:left;border-bottom:1px solid #eee;padding:6px;font-size:12px'>Attempt</th>" +
          "<th style='text-align:left;border-bottom:1px solid #eee;padding:6px;font-size:12px'>Started</th>" +
          "<th style='text-align:left;border-bottom:1px solid #eee;padding:6px;font-size:12px'>Status</th>" +
          "<th style='text-align:left;border-bottom:1px solid #eee;padding:6px;font-size:12px'>Code</th>" +
          "<th style='text-align:left;border-bottom:1px solid #eee;padding:6px;font-size:12px'>Error</th>" +
        "</tr></thead><tbody>" +
        attempts.map((a) => (
          "<tr>" +
            "<td class='mono' style='border-bottom:1px solid #f3f3f3;padding:6px'>" + escapeHtml(a.attemptNumber ?? "") + "</td>" +
            "<td class='mono' style='border-bottom:1px solid #f3f3f3;padding:6px'>" + escapeHtml(a.startedAt ?? "") + "</td>" +
            "<td style='border-bottom:1px solid #f3f3f3;padding:6px'>" + escapeHtml(a.status ?? "") + "</td>" +
            "<td class='mono' style='border-bottom:1px solid #f3f3f3;padding:6px'>" + escapeHtml(a.statusCode ?? "") + "</td>" +
            "<td class='mono' style='border-bottom:1px solid #f3f3f3;padding:6px'>" + escapeHtml(short(a.error ?? "")) + "</td>" +
          "</tr>"
        )).join("") +
        "</tbody></table>"
      )
    : "<div class='muted'>No attempt logs.</div>";

  detailEl.innerHTML =
    "<div style='display:flex;flex-direction:column;gap:10px'>" +

      "<div>" +
        "<div><strong>Delivery</strong> <span class='mono'>#" + escapeHtml(d.id) + "</span></div>" +
        "<div class='muted'>" + escapeHtml(d.createdAt ?? "") + "</div>" +
      "</div>" +

      "<div>" +
        "<div><strong>Event:</strong> " + escapeHtml(d.event ?? "") + "</div>" +
        "<div><strong>Status:</strong> " + statusPill(d.status ?? "") + "</div>" +
        "<div><strong>Attempts:</strong> <span class='mono'>" + escapeHtml(d.attempts ?? "") + "</span></div>" +
        "<div><strong>Last:</strong> <span class='mono'>" +
          escapeHtml(d.lastStatusCode ?? "") + "</span> " +
          "<span class='mono'>" + escapeHtml(short(d.lastError ?? "")) + "</span>" +
        "</div>" +
      "</div>" +

      "<div>" +
        "<div><strong>Endpoint:</strong> <span class='mono'>" + escapeHtml(endpointLine) + "</span></div>" +
        (d.endpoint?.subscribedEvents
          ? "<div class='muted'>Subscribed: " + escapeHtml(String(d.endpoint.subscribedEvents)) + "</div>"
          : "") +
      "</div>" +

      (contextLine
        ? "<div><strong>Context:</strong> <span class='mono'>" + escapeHtml(contextLine) + "</span></div>"
        : "") +

      "<div>" +
        "<div><strong>Attempt logs</strong></div>" +
        attemptRows +
      "</div>" +

      "<div>" +
        "<div><strong>Payload</strong></div>" +
        "<pre>" + escapeHtml(JSON.stringify(d.payload ?? {}, null, 2)) + "</pre>" +
      "</div>" +

    "</div>";
}


  async function fetchDeliveries(opts) {
    const reset = opts && opts.reset === true;

    const token = getToken();
    if (!token) {
      alert("Paste your admin token first, click Save Token, then click Refresh.");
      return;
    }

    if (reset) {
      deliveriesEl.innerHTML = "";
      nextCursor = null;
      detailEl.innerHTML = "<div class='muted'>Click a delivery on the left.</div>";
    }

    const params = {
      take: 50,
      cursor: nextCursor,
      status: statusEl.value || undefined,
      endpointId: (endpointIdEl.value || "").trim() || undefined,
      event: (eventEl.value || "").trim() || undefined,
    };

    const url = "/admin/webhooks/deliveries" + qs(params);

    const r = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
    });

    if (r.status === 304) return;

    if (!r.ok) {
      const text = await r.text();
      console.error("Deliveries fetch failed:", r.status, text);
      alert("Failed to load deliveries: " + r.status + "\\n" + text);
      return;
    }

    const data = await r.json();

    // ✅ backend returns an ARRAY, but older code expected { items: [...] }
    const items = Array.isArray(data) ? data : (data.items || []);
    nextCursor = Array.isArray(data) ? null : (data.nextCursor ?? null);


    console.log("Loaded deliveries:", items.length);

    for (const d of items) {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";

      tr.innerHTML =
        "<td class='mono'>" + escapeHtml(d.id) + "</td>" +
        "<td>" + escapeHtml(d.event) + "</td>" +
        "<td>" + statusPill(d.status) + "</td>" +
        "<td class='mono'>" + escapeHtml(d.attempts ?? "") + "</td>" +
        "<td class='mono'>" +
          escapeHtml(d.lastStatusCode ?? "") + " " +
          escapeHtml(short(d.lastError ?? "")) +
        "</td>" +
        "<td class='mono'>" + escapeHtml(d.endpoint?.id ?? d.endpointId ?? "") + "</td>";

      tr.addEventListener("click", function () {
        fetchDeliveryDetail(d.id);
      });

      deliveriesEl.appendChild(tr);
    }
  }

  // token persistence
  const saved = localStorage.getItem("adminToken");
  if (saved) tokenEl.value = saved;

  document.getElementById("saveToken").addEventListener("click", () => {
    localStorage.setItem("adminToken", (tokenEl.value || "").trim());
    alert("Saved.");
  });

  document.getElementById("refresh").addEventListener("click", () => fetchDeliveries({ reset: true }));
  document.getElementById("loadMore").addEventListener("click", () => {
    if (!nextCursor) return alert("No more.");
    fetchDeliveries({ reset: false });
  });

  if (saved) fetchDeliveries({ reset: true });
</script>

</body>
</html>`);
  }
);


// --- Single global error handler (keep at the end, after ALL routes) ---
app.use(createGlobalErrorHandler({ logger, captureException }));


// --- Start server + worker (start-once + graceful shutdown) ---

let stopWebhookWorker: null | (() => void) = null;

async function startWorkersOnce() {
  if (stopWebhookWorker) return;

  // DB ping before starting worker (prevents noisy loop on boot)
  await prisma.$queryRaw`SELECT 1`;

  stopWebhookWorker = startWebhookWorker();
  webhookWorkerStartedAt = new Date();

  console.log("[webhooks] worker started at", webhookWorkerStartedAt.toISOString());
}

// Worker moved to dedicated Railway worker service
// startWorkersOnce().catch((e) => {
//   console.error("[startup] failed to start workers:", e);
// });

const server = app.listen(PORT, () => {
  logger.info("server.listening", { port: PORT });
});

async function shutdown(signal: string) {
  logger.info("shutdown.received", { signal });

  try {

    // stop accepting new HTTP requests
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info("shutdown.http_closed");

    // disconnect prisma cleanly (prevents hanging in prod)
    try {
      const { prisma } = await import("./prisma"); // adjust path if server.ts is in src/
      await prisma.$disconnect();
      logger.info("shutdown.prisma_disconnected");
    } catch (e) {
      // If your server.ts imports prisma from "../prisma" etc, just import directly there instead
      logger.warn("shutdown.prisma_disconnect_failed", { message: String((e as any)?.message ?? e) });
    }
  } catch (e) {
    logger.error("shutdown.error", { message: String((e as any)?.message ?? e) });
  } finally {
    await flushSentry().catch(() => null);
    process.exit(0);
  }
}

// Common termination signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Helpful in some hosting environments
process.on("uncaughtException", (err) => {
  logger.error("process.uncaughtException", { message: String((err as any)?.message ?? err) });
  captureException(err, { kind: "uncaughtException" });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandledRejection", { message: String((reason as any)?.message ?? reason) });
  captureException(reason, { kind: "unhandledRejection" });
  shutdown("unhandledRejection");
});
