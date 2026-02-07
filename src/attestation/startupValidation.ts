function envTrue(name: string): boolean {
  return String(process.env[name] ?? "").toLowerCase() === "true";
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parsePlatforms(): Array<"android" | "ios"> {
  /**
   * Optional env var:
   * - APP_ATTESTATION_PLATFORMS: comma-separated list (default "android,ios")
   *   Use this only if your backend intentionally serves a single platform.
   */
  const raw = String(process.env.APP_ATTESTATION_PLATFORMS ?? "android,ios");
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

function hasAny(...names: string[]): boolean {
  return names.some((n) => {
    const v = String(process.env[n] ?? "").trim();
    return Boolean(v);
  });
}

function requireEnv(name: string, missing: string[]) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) missing.push(name);
}

function requireOneOf(names: string[], missing: string[]) {
  if (!hasAny(...names)) missing.push(`one_of:${names.join("|")}`);
}

function buildHelpText(): string {
  const lines: string[] = [];
  lines.push("Attestation startup validation failed.");
  lines.push("");
  lines.push("Required env vars when APP_ATTESTATION_ENFORCE=true in production:");
  lines.push("");
  lines.push("Android (Play Integrity):");
  lines.push("- ANDROID_PLAY_INTEGRITY_PACKAGE_NAME");
  lines.push("- ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS");
  lines.push("- One of: GOOGLE_SERVICE_ACCOUNT_JSON | GOOGLE_SERVICE_ACCOUNT_JSON_B64 | GOOGLE_APPLICATION_CREDENTIALS");
  lines.push("");
  lines.push("iOS (App Attest / DeviceCheck):");
  lines.push("- IOS_APP_ATTEST_BUNDLE_ID");
  lines.push("- IOS_APP_ATTEST_ALLOWED_KEY_IDS (or '*')");
  lines.push("- IOS_APP_ATTEST_VERIFY_URL (verification provider endpoint)");
  lines.push("");
  lines.push("Optional:");
  lines.push("- APP_ATTESTATION_PLATFORMS=android,ios (defaults to both)");
  lines.push("- IOS_APP_ATTEST_VERIFY_AUTH_HEADER");
  lines.push("- ANDROID_PLAY_INTEGRITY_MAX_TOKEN_AGE_SECONDS, IOS_APP_ATTEST_MAX_TOKEN_AGE_SECONDS, etc.");
  return lines.join("\n");
}

/**
 * Fail-fast guardrail.
 *
 * In production with APP_ATTESTATION_ENFORCE=true, missing verifier configuration should stop the
 * server from starting. This prevents a deployment that *intends* to enforce attestation from
 * running with a broken verifier configuration.
 */
export function validateAttestationStartupOrThrow(): void {
  if (!isProduction()) return;
  if (!envTrue("APP_ATTESTATION_ENFORCE")) return;

  const missing: string[] = [];
  const platforms = parsePlatforms();

  if (platforms.includes("android")) {
    requireEnv("ANDROID_PLAY_INTEGRITY_PACKAGE_NAME", missing);
    requireEnv("ANDROID_PLAY_INTEGRITY_CERT_SHA256_DIGESTS", missing);
    requireOneOf(
      ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SERVICE_ACCOUNT_JSON_B64", "GOOGLE_APPLICATION_CREDENTIALS"],
      missing
    );
  }

  if (platforms.includes("ios")) {
    requireEnv("IOS_APP_ATTEST_BUNDLE_ID", missing);
    requireEnv("IOS_APP_ATTEST_ALLOWED_KEY_IDS", missing);
    requireEnv("IOS_APP_ATTEST_VERIFY_URL", missing);
  }

  if (missing.length) {
    const rendered = missing
      .map((m) => (m.startsWith("one_of:") ? `- ${m.slice("one_of:".length)}` : `- ${m}`))
      .join("\n");

    const err = new Error(
      `FATAL: App attestation is enforced but verifier config is missing:\n${rendered}\n\n${buildHelpText()}`
    );
    // Intentionally no console logging here: letting the process crash will surface the error
    // via process manager logs, without risking printing any secrets.
    throw err;
  }
}
