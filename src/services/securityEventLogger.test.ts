import test from "node:test";
import assert from "node:assert/strict";

import { scrubSecurityMetadata } from "./securityEventLogger";

test("scrubSecurityMetadata redacts sensitive keys", () => {
  const input = {
    password: "supersecret",
    token: "Bearer abc.def.ghi",
    stripeSecretKey: "sk_live_123",
    nested: {
      webhookSecret: "whsec_456",
      ok: "value",
    },
  };

  const out = scrubSecurityMetadata(input) as any;

  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.stripeSecretKey, "[REDACTED]");
  assert.equal(out.nested.webhookSecret, "[REDACTED]");
  assert.equal(out.nested.ok, "value");
});

test("scrubSecurityMetadata redacts jwt-like strings", () => {
  const input = {
    note: "ok",
    jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjF9.signature",
  };

  const out = scrubSecurityMetadata(input) as any;
  assert.equal(out.note, "ok");
  assert.equal(out.jwt, "[REDACTED]");
});
