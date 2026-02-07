import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import express from "express";

import { enforceAttestationForSensitiveRoutes } from "./enforceAttestationForSensitiveRoutes";

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("scoped attestation: enforcement OFF does not block sensitive routes", async () => {
  const old = {
    enforce: process.env.APP_ATTESTATION_ENFORCE,
    allowDev: process.env.ALLOW_UNATTESTED_DEV,
    nodeEnv: process.env.NODE_ENV,
  };

  try {
    process.env.APP_ATTESTATION_ENFORCE = "false";
    process.env.ALLOW_UNATTESTED_DEV = "false";
    process.env.NODE_ENV = "production";

    const app = express();
    enforceAttestationForSensitiveRoutes(app);

    app.get("/jobs/browse", (_req, res) => res.json({ ok: true }));
    app.post("/jobs", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (baseUrl) => {
      const browse = await fetch(`${baseUrl}/jobs/browse`);
      assert.equal(browse.status, 200);

      const create = await fetch(`${baseUrl}/jobs`, { method: "POST" });
      assert.equal(create.status, 200);
    });
  } finally {
    process.env.APP_ATTESTATION_ENFORCE = old.enforce;
    process.env.ALLOW_UNATTESTED_DEV = old.allowDev;
    process.env.NODE_ENV = old.nodeEnv;
  }
});

test("scoped attestation: enforcement ON blocks sensitive routes without token but allows browse", async () => {
  const old = {
    enforce: process.env.APP_ATTESTATION_ENFORCE,
    allowDev: process.env.ALLOW_UNATTESTED_DEV,
    nodeEnv: process.env.NODE_ENV,
  };

  try {
    process.env.APP_ATTESTATION_ENFORCE = "true";
    process.env.ALLOW_UNATTESTED_DEV = "false";
    process.env.NODE_ENV = "production";

    const app = express();
    enforceAttestationForSensitiveRoutes(app);

    app.get("/jobs/browse", (_req, res) => res.json({ ok: true }));
    app.post("/jobs", (_req, res) => res.json({ ok: true }));

    await withServer(app, async (baseUrl) => {
      const browse = await fetch(`${baseUrl}/jobs/browse`);
      assert.equal(browse.status, 200);

      const create = await fetch(`${baseUrl}/jobs`, { method: "POST" });
      assert.equal(create.status, 401);
      const body = await create.json();
      assert.equal(body?.error, "App attestation required");
    });
  } finally {
    process.env.APP_ATTESTATION_ENFORCE = old.enforce;
    process.env.ALLOW_UNATTESTED_DEV = old.allowDev;
    process.env.NODE_ENV = old.nodeEnv;
  }
});
