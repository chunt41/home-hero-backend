import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import helmet from "helmet";

import { createBasicAuthForAdminUi, createRequireAdminUiEnabled } from "./adminWebhooksUiGuard";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

function basic(user: string, pass: string) {
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

test("admin webhooks UI: prod + disabled => 404 (no auth prompt)", async (t) => {
  const env: any = {
    NODE_ENV: "production",
    ADMIN_UI_ENABLED: "false",
    ADMIN_UI_BASIC_USER: "u",
    ADMIN_UI_BASIC_PASS: "p",
  };

  const app = express();
  app.get(
    "/admin/webhooks/ui",
    createRequireAdminUiEnabled(env),
    helmet.frameguard({ action: "deny" }),
    createBasicAuthForAdminUi(env),
    (_req, res) => res.status(200).send("ok")
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/webhooks/ui`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("www-authenticate"), null);
});

test("admin webhooks UI: prod + enabled + missing auth => 401 with WWW-Authenticate", async (t) => {
  const env: any = {
    NODE_ENV: "production",
    ADMIN_UI_ENABLED: "true",
    ADMIN_UI_BASIC_USER: "u",
    ADMIN_UI_BASIC_PASS: "p",
  };

  const app = express();
  app.get(
    "/admin/webhooks/ui",
    createRequireAdminUiEnabled(env),
    helmet.frameguard({ action: "deny" }),
    createBasicAuthForAdminUi(env),
    (_req, res) => res.status(200).send("ok")
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/webhooks/ui`);
  assert.equal(res.status, 401);
  assert.ok(String(res.headers.get("www-authenticate") ?? "").toLowerCase().includes("basic"));
});

test("admin webhooks UI: prod + enabled + wrong auth => 401", async (t) => {
  const env: any = {
    NODE_ENV: "production",
    ADMIN_UI_ENABLED: "true",
    ADMIN_UI_BASIC_USER: "u",
    ADMIN_UI_BASIC_PASS: "p",
  };

  const app = express();
  app.get(
    "/admin/webhooks/ui",
    createRequireAdminUiEnabled(env),
    helmet.frameguard({ action: "deny" }),
    createBasicAuthForAdminUi(env),
    (_req, res) => res.status(200).send("ok")
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/webhooks/ui`, {
    headers: { Authorization: basic("u", "wrong") },
  });
  assert.equal(res.status, 401);
});

test("admin webhooks UI: prod + enabled + correct auth => 200 and frameguard header", async (t) => {
  const env: any = {
    NODE_ENV: "production",
    ADMIN_UI_ENABLED: "true",
    ADMIN_UI_BASIC_USER: "u",
    ADMIN_UI_BASIC_PASS: "p",
  };

  const app = express();
  app.get(
    "/admin/webhooks/ui",
    createRequireAdminUiEnabled(env),
    helmet.frameguard({ action: "deny" }),
    createBasicAuthForAdminUi(env),
    (_req, res) => res.status(200).send("ok")
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/webhooks/ui`, {
    headers: { Authorization: basic("u", "p") },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("admin webhooks UI: non-prod + enabled => no basic auth required", async (t) => {
  const env: any = {
    NODE_ENV: "development",
    ADMIN_UI_ENABLED: "true",
    ADMIN_UI_BASIC_USER: "",
    ADMIN_UI_BASIC_PASS: "",
  };

  const app = express();
  app.get(
    "/admin/webhooks/ui",
    createRequireAdminUiEnabled(env),
    helmet.frameguard({ action: "deny" }),
    createBasicAuthForAdminUi(env),
    (_req, res) => res.status(200).send("ok")
  );

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/admin/webhooks/ui`);
  assert.equal(res.status, 200);
});
