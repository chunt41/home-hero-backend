import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";

import { createAuthLoginHandler } from "./authLogin";

function makeApp(deps: Parameters<typeof createAuthLoginHandler>[0]) {
  const app = express();
  app.use(express.json());
  app.post("/auth/login", (req, _res, next) => {
    // Minimal shape to satisfy handler expectations.
    // The handler reads validated.body; in prod it's added by validate(loginSchema).
    (req as any).validated = { body: req.body };
    next();
  });
  app.post("/auth/login", createAuthLoginHandler(deps));
  return app;
}

async function postJson(baseUrl: string, path: string, body: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

test("POST /auth/login returns identical 401 for user_not_found vs bad_password", async (t) => {
  const existingEmail = "exists@example.com";
  const missingEmail = "missing@example.com";

  const prisma = {
    user: {
      findUnique: async ({ where }: any) => {
        if (where?.email === existingEmail) {
          return {
            id: 1,
            role: "CONSUMER",
            name: "Existing User",
            email: existingEmail,
            passwordHash: "hash",
            emailVerifiedAt: null,
            subscription: { tier: "FREE" },
          };
        }
        return null;
      },
    },
  } as any;

  const bcryptCompare = async () => false;
  const jwtSign = () => "token";
  const logSecurityEvent = async () => undefined;

  const loginBruteForce = {
    check: async () => ({ allowed: true as const }),
    onFailure: async () => ({ cooldownTriggered: null, ipCount: 1, identCount: 1 }),
    onSuccess: async () => ({ ok: true as const }),
  };

  const app = makeApp({
    prisma,
    bcryptCompare,
    jwtSign,
    jwtSecret: "test-secret",
    logSecurityEvent,
    loginBruteForce,
  });

  const server = app.listen(0);
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rMissing = await postJson(baseUrl, "/auth/login", {
    email: missingEmail,
    password: "wrong",
  });

  const rBadPass = await postJson(baseUrl, "/auth/login", {
    email: existingEmail,
    password: "wrong",
  });

  assert.equal(rMissing.status, 401);
  assert.equal(rBadPass.status, 401);
  assert.deepEqual(rMissing.body, rBadPass.body);
});
