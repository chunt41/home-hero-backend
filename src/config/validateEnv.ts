type IssueLevel = "error" | "warn";

export type EnvValidationIssue = {
  level: IssueLevel;
  group:
    | "Database"
    | "Redis / Rate Limiting"
    | "Stripe"
    | "Object Storage"
    | "Email"
    | "Expo Push"
    | "Sentry"
    | "Attestation";
  message: string;
};

export type EnvValidationResult = {
  issues: EnvValidationIssue[];
  errors: EnvValidationIssue[];
  warnings: EnvValidationIssue[];
};

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return String(env.NODE_ENV ?? "development") === "production";
}

function trim(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? "").trim();
}

function envTrue(env: NodeJS.ProcessEnv, name: string): boolean {
  return trim(env, name).toLowerCase() === "true";
}

function push(issues: EnvValidationIssue[], level: IssueLevel, group: EnvValidationIssue["group"], message: string) {
  issues.push({ level, group, message });
}

function requireVar(
  issues: EnvValidationIssue[],
  level: IssueLevel,
  group: EnvValidationIssue["group"],
  env: NodeJS.ProcessEnv,
  name: string,
  help?: string
) {
  if (!trim(env, name)) {
    push(
      issues,
      level,
      group,
      help ? `Missing required env var: ${name} (${help})` : `Missing required env var: ${name}`
    );
  }
}

function requireOneOf(
  issues: EnvValidationIssue[],
  level: IssueLevel,
  group: EnvValidationIssue["group"],
  env: NodeJS.ProcessEnv,
  names: string[],
  help?: string
) {
  const ok = names.some((n) => Boolean(trim(env, n)));
  if (!ok) {
    push(
      issues,
      level,
      group,
      help
        ? `Missing required env var: one of ${names.join(" | ")} (${help})`
        : `Missing required env var: one of ${names.join(" | ")}`
    );
  }
}

function validateSentryDsnOrIssue(
  issues: EnvValidationIssue[],
  level: IssueLevel,
  env: NodeJS.ProcessEnv
) {
  const dsn = trim(env, "SENTRY_DSN");
  if (!dsn) return;

  try {
    const u = new URL(dsn);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      push(issues, level, "Sentry", "SENTRY_DSN must be an http(s) URL.");
    }
    if (!u.host) {
      push(issues, level, "Sentry", "SENTRY_DSN must include a host.");
    }
  } catch {
    push(issues, level, "Sentry", "SENTRY_DSN is set but is not a valid URL.");
  }
}

function parseAttestationPlatforms(env: NodeJS.ProcessEnv): Array<"android" | "ios"> {
  const raw = String(env.APP_ATTESTATION_PLATFORMS ?? "android,ios");
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const out: Array<"android" | "ios"> = [];
  for (const p of parts) {
    if (p === "android" || p === "ios") out.push(p);
  }
  return out.length ? out : ["android", "ios"];
}

function validateAttestationConfig(
  issues: EnvValidationIssue[],
  level: IssueLevel,
  env: NodeJS.ProcessEnv
) {
  // Defense-in-depth should be explicitly configured in production so it can't be silently disabled.
  if (isProduction(env)) {
    const raw = env.APP_ATTESTATION_ENFORCE;
    if (raw == null || String(raw).trim() === "") {
      push(
        issues,
        "warn",
        "Attestation",
        "APP_ATTESTATION_ENFORCE is not set; defaulting to false (attestation enforcement disabled)."
      );
    }
  }

  if (!envTrue(env, "APP_ATTESTATION_ENFORCE")) return;

  const platforms = parseAttestationPlatforms(env);
  if (platforms.includes("android")) {
    requireVar(issues, level, "Attestation", env, "ANDROID_PLAY_INTEGRITY_PACKAGE_NAME");
    requireVar(issues, level, "Attestation", env, "ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS");
    requireOneOf(
      issues,
      level,
      "Attestation",
      env,
      ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON_B64", "GOOGLE_APPLICATION_CREDENTIALS"],
      "required when APP_ATTESTATION_ENFORCE=true (Android verifier)"
    );
  }

  if (platforms.includes("ios")) {
    requireVar(issues, level, "Attestation", env, "IOS_APP_ATTEST_BUNDLE_ID");
    requireVar(issues, level, "Attestation", env, "IOS_APP_ATTEST_ALLOWED_KEY_IDS");
    requireVar(issues, level, "Attestation", env, "IOS_APP_ATTEST_VERIFY_URL");
  }
}

function validateEmailProvider(
  issues: EnvValidationIssue[],
  level: IssueLevel,
  env: NodeJS.ProcessEnv
) {
  const provider = trim(env, "EMAIL_PROVIDER").toLowerCase();

  if (!provider) {
    push(
      issues,
      level,
      "Email",
      "EMAIL_PROVIDER is not configured (required for verification + reset emails)."
    );
    return;
  }

  requireVar(issues, level, "Email", env, "EMAIL_FROM", "from-address for transactional emails");

  if (provider === "smtp") {
    requireVar(issues, level, "Email", env, "SMTP_HOST");
    requireVar(issues, level, "Email", env, "SMTP_PORT");
    requireVar(issues, level, "Email", env, "SMTP_USER");
    requireVar(issues, level, "Email", env, "SMTP_PASS");
    return;
  }

  if (provider === "sendgrid") {
    requireVar(issues, level, "Email", env, "SENDGRID_API_KEY");
    return;
  }

  if (provider === "resend") {
    requireVar(issues, level, "Email", env, "RESEND_API_KEY");
    return;
  }

  push(
    issues,
    level,
    "Email",
    "EMAIL_PROVIDER must be one of: smtp | sendgrid | resend"
  );
}

function validateObjectStorage(
  issues: EnvValidationIssue[],
  prodLevel: IssueLevel,
  env: NodeJS.ProcessEnv
) {
  const provider = trim(env, "OBJECT_STORAGE_PROVIDER").toLowerCase();
  if (!provider) {
    push(
      issues,
      prodLevel,
      "Object Storage",
      "OBJECT_STORAGE_PROVIDER is not configured (required for attachment storage)."
    );
    return;
  }

  if (provider !== "s3") {
    push(
      issues,
      prodLevel,
      "Object Storage",
      "OBJECT_STORAGE_PROVIDER must be 's3' (production requires object storage)."
    );
    return;
  }

  requireVar(issues, prodLevel, "Object Storage", env, "OBJECT_STORAGE_S3_BUCKET");
  requireVar(issues, prodLevel, "Object Storage", env, "OBJECT_STORAGE_S3_REGION");
  requireVar(issues, prodLevel, "Object Storage", env, "OBJECT_STORAGE_S3_ACCESS_KEY_ID");
  requireVar(issues, prodLevel, "Object Storage", env, "OBJECT_STORAGE_S3_SECRET_ACCESS_KEY");
}

function validateStripe(
  issues: EnvValidationIssue[],
  env: NodeJS.ProcessEnv
) {
  const prod = isProduction(env);
  requireVar(issues, "error", "Stripe", env, "STRIPE_SECRET_KEY");

  if (prod) {
    requireVar(issues, "error", "Stripe", env, "STRIPE_WEBHOOK_SECRET", "required for webhook verification");
  } else {
    if (!trim(env, "STRIPE_WEBHOOK_SECRET")) {
      push(issues, "warn", "Stripe", "STRIPE_WEBHOOK_SECRET is not set; Stripe webhooks will not verify in dev.");
    }
  }
}

function validateRedisRateLimiting(
  issues: EnvValidationIssue[],
  env: NodeJS.ProcessEnv
) {
  const prod = isProduction(env);
  const url = trim(env, "RATE_LIMIT_REDIS_URL");
  if (prod) {
    if (!url) {
      push(
        issues,
        "error",
        "Redis / Rate Limiting",
        "Missing required env var: RATE_LIMIT_REDIS_URL (required in production for Redis-backed rate limiting)."
      );
    }
  } else {
    if (!url) {
      push(
        issues,
        "warn",
        "Redis / Rate Limiting",
        "RATE_LIMIT_REDIS_URL is not set; Redis-backed rate limiting and push rate caps will be disabled (fail-open)."
      );
    }
  }
}

function validateDatabase(
  issues: EnvValidationIssue[],
  env: NodeJS.ProcessEnv
) {
  requireVar(issues, "error", "Database", env, "DATABASE_URL");
  requireVar(issues, "error", "Database", env, "JWT_SECRET");
}

function validateExpoPush(issues: EnvValidationIssue[]) {
  // Expo push uses the public Expo endpoint; no additional server-side credentials are required.
  // We still keep this group for completeness/visibility in startup validation output.
  return;
}

function groupAndRender(issues: EnvValidationIssue[], heading: string): string {
  const byGroup = new Map<string, EnvValidationIssue[]>();
  for (const i of issues) {
    const k = i.group;
    const arr = byGroup.get(k) ?? [];
    arr.push(i);
    byGroup.set(k, arr);
  }

  const lines: string[] = [];
  lines.push(heading);
  for (const [group, groupIssues] of byGroup) {
    lines.push("");
    lines.push(`[${group}]`);
    for (const gi of groupIssues) {
      lines.push(`- ${gi.message}`);
    }
  }
  return lines.join("\n");
}

export function validateEnv(processEnv: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const issues: EnvValidationIssue[] = [];
  const prod = isProduction(processEnv);

  validateDatabase(issues, processEnv);
  validateRedisRateLimiting(issues, processEnv);
  validateStripe(issues, processEnv);

  // Object storage is required in production; in dev it is optional.
  validateObjectStorage(issues, prod ? "error" : "warn", processEnv);

  // Email is required in production; in dev it is optional.
  validateEmailProvider(issues, prod ? "error" : "warn", processEnv);

  validateExpoPush(issues);
  validateSentryDsnOrIssue(issues, prod ? "error" : "warn", processEnv);

  // Attestation is required only when enforcement is ON.
  validateAttestationConfig(issues, prod ? "error" : "warn", processEnv);

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warn");

  return { issues, errors, warnings };
}

/**
 * Startup guardrail.
 *
 * - In production: throw if any required env is missing.
 * - In non-prod: warn for optional features, but still throw for truly-required core vars.
 */
export function validateEnvAtStartup(processEnv: NodeJS.ProcessEnv = process.env): void {
  const prod = isProduction(processEnv);
  const { errors, warnings } = validateEnv(processEnv);

  if (errors.length) {
    const rendered = groupAndRender(
      errors,
      prod
        ? "FATAL: Startup environment validation failed (production)."
        : "FATAL: Startup environment validation failed."
    );
    throw new Error(rendered);
  }

  if (warnings.length) {
    const rendered = groupAndRender(
      warnings,
      "WARNING: Startup environment validation found missing optional configuration."
    );
    // Keep warnings concise but visible.
    console.warn(rendered);
  }
}
