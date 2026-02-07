import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function getRepoRoot(): string {
  // This test file lives at src/productionReadiness/*.test.ts
  return path.resolve(__dirname, "..", "..");
}

test("deployment gate: package.json exposes verify:gate and includes required suites", () => {
  const root = getRepoRoot();
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  const scripts = pkg?.scripts ?? {};
  const cmd = String(scripts["verify:gate"] ?? "");

  assert.ok(cmd, "Expected package.json scripts.verify:gate to exist");

  const requiredSnippets = [
    "npm run lint",
    "node --test",

    // Production readiness suite (env/storage/redis/stripe/attestation)
    "src/productionReadiness/**/*.test.ts",

    // Webhook idempotency
    "src/services/stripeServiceWebhookIdempotency.test.ts",
    "src/routes/paymentsWebhookIdempotency.test.ts",

    // Provider search
    "src/routes/providersSearch.test.ts",

    // Contact exchange + anti-scam
    "src/routes/contactExchange.test.ts",
    "src/services/jobMessageSendModeration.test.ts",
    "src/services/riskScoring.messageModeration.test.ts",

    // Push cleanup
    "src/services/expoPush.test.ts",
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(cmd.includes(snippet), `Expected verify:gate to include: ${snippet}`);
  }
});

test("deployment gate: docs exist and mention verify:gate", () => {
  const root = getRepoRoot();
  const docPath = path.join(root, "docs", "deployment-gate.md");
  assert.ok(fs.existsSync(docPath), "Expected docs/deployment-gate.md to exist");

  const content = fs.readFileSync(docPath, "utf8");
  assert.ok(content.includes("npm run verify:gate"), "Expected docs to mention npm run verify:gate");
});
