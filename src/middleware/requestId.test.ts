import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

import { requestIdMiddleware } from "./requestId";
import { attachRequestIdToErrorJsonMiddleware } from "./attachRequestIdToErrorJson";

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

test("X-Correlation-Id is accepted and echoed", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(attachRequestIdToErrorJsonMiddleware);
  app.get("/err", (_req, res) => res.status(400).json({ error: "bad" }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/err`, {
    headers: { "X-Correlation-Id": "abc-123" },
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-request-id"), "abc-123");
  assert.equal(body.requestId, "abc-123");
});

test("X-Request-Id is accepted when X-Correlation-Id absent", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(attachRequestIdToErrorJsonMiddleware);
  app.get("/err", (_req, res) => res.status(400).json({ error: "bad" }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/err`, {
    headers: { "X-Request-Id": "req_42" },
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-request-id"), "req_42");
  assert.equal(body.requestId, "req_42");
});

test("Invalid inbound IDs are ignored and a requestId is generated", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(attachRequestIdToErrorJsonMiddleware);
  app.get("/err", (_req, res) => res.status(500).json({ error: "nope" }));

  const { server, baseUrl } = await listen(app);
  t.after(() => server.close());

  const res = await fetch(`${baseUrl}/err`, {
    headers: { "X-Correlation-Id": "not ok spaces" },
  });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(typeof res.headers.get("x-request-id"), "string");
  assert.notEqual(res.headers.get("x-request-id"), "not ok spaces");
  assert.equal(body.requestId, res.headers.get("x-request-id"));
});
