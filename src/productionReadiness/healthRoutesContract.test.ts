import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function getRepoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

test("production readiness: server defines stable health/readiness endpoints", () => {
  const serverPath = path.join(getRepoRoot(), "src", "server.ts");
  const content = fs.readFileSync(serverPath, "utf8");

  // Kubernetes-style endpoints (stable)
  assert.ok(content.includes("app.get(\"/healthz\""), "Expected /healthz endpoint");
  assert.ok(content.includes("app.get(\"/readyz\""), "Expected /readyz endpoint");

  // Human/debug endpoints
  assert.ok(content.includes("app.get(\"/health\""), "Expected /health endpoint");
  assert.ok(content.includes("app.get(\"/health/db\""), "Expected /health/db endpoint");
  assert.ok(content.includes("app.get(\"/ready\""), "Expected /ready endpoint");

  // Avoid shipping whimsical content in production health responses.
  assert.ok(!content.includes("🚀"), "Health endpoints should not contain emoji payloads");
});
