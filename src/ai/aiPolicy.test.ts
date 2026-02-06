import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.join(process.cwd(), "src");

function walkFiles(dir: string, out: string[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    if (ent.name === "generated") continue;

    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, out);
      continue;
    }

    if (!/\.(ts|tsx|js|jsx)$/.test(ent.name)) continue;
    out.push(full);
  }
}

const bannedModuleMatchers: Array<{ label: string; re: RegExp }> = [
  { label: "openai", re: /^openai$/ },
  { label: "@ai-sdk/openai", re: /^@ai-sdk\/openai/ },
  { label: "@ai-sdk/anthropic", re: /^@ai-sdk\/anthropic/ },
  { label: "@anthropic-ai/sdk", re: /^@anthropic-ai\/sdk/ },
  { label: "anthropic", re: /^anthropic$/ },
  { label: "@google/generative-ai", re: /^@google\/generative-ai/ },
  { label: "google-generativeai", re: /^google-generativeai$/ },
  { label: "groq-sdk", re: /^groq-sdk$/ },
  { label: "mistralai", re: /^mistralai/ },
  { label: "cohere-ai", re: /^cohere-ai$/ },
  { label: "together-ai", re: /^together-ai$/ },
  { label: "@aws-sdk/client-bedrock-runtime", re: /^@aws-sdk\/client-bedrock-runtime$/ },
  { label: "langchain", re: /^langchain/ },
];

function findBannedImports(fileText: string): string[] {
  const violations: string[] = [];

  // ES imports: import ... from "module";
  const importFromRe = /\bfrom\s+["']([^"']+)["']/g;
  // Side-effect imports: import "module";
  const importSideEffectRe = /\bimport\s+["']([^"']+)["']/g;
  // CommonJS: require("module")
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  const collect = (re: RegExp) => {
    for (const m of fileText.matchAll(re)) {
      const mod = String(m[1] ?? "");
      for (const bm of bannedModuleMatchers) {
        if (bm.re.test(mod)) violations.push(mod);
      }
    }
  };

  collect(importFromRe);
  collect(importSideEffectRe);
  collect(requireRe);

  return [...new Set(violations)];
}

test("AI SDKs are only imported in src/ai/aiGateway.ts", () => {
  const allowed = new Set([
    path.join(SRC_ROOT, "ai", "aiGateway.ts"),
  ]);

  const files: string[] = [];
  walkFiles(SRC_ROOT, files);

  const violations: Array<{ file: string; modules: string[] }> = [];

  for (const file of files) {
    if (allowed.has(file)) continue;
    if (file.endsWith(path.join("src", "ai", "aiPolicy.test.ts"))) continue;

    const text = fs.readFileSync(file, "utf8");
    const mods = findBannedImports(text);
    if (mods.length) violations.push({ file, modules: mods });
  }

  assert.equal(
    violations.length,
    0,
    `Found banned AI SDK imports outside aiGateway:\n${violations
      .map((v) => `- ${path.relative(process.cwd(), v.file)}: ${v.modules.join(", ")}`)
      .join("\n")}`
  );
});
