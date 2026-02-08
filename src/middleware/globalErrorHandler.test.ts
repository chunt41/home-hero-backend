import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { patchAppForAsyncErrors } from "./asyncWrap";
import { globalErrorHandler } from "./globalErrorHandler";

async function start(app: any) {
  return await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("global error handler returns consistent JSON for sync throws", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const app = patchAppForAsyncErrors(express());
  app.get("/sync", (_req, _res) => {
    throw new Error("boom sk_live_123 postgresql://secret");
  });
  app.use(globalErrorHandler);

  const { url, close } = await start(app);
  const res = await fetch(`${url}/sync`);
  const json = await res.json();

  assert.equal(res.status, 500);
  assert.equal(json.error, "Internal server error");
  assert.equal(typeof json.requestId, "string");

  await close();
  process.env.NODE_ENV = prev;
});

test("global error handler returns consistent JSON for async throws", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const app = patchAppForAsyncErrors(express());
  app.get("/async", async () => {
    await Promise.resolve();
    throw new Error("async boom");
  });
  app.use(globalErrorHandler);

  const { url, close } = await start(app);
  const res = await fetch(`${url}/async`);
  const json = await res.json();

  assert.equal(res.status, 500);
  assert.equal(json.error, "Internal server error");
  assert.equal(typeof json.requestId, "string");

  await close();
  process.env.NODE_ENV = prev;
});

test("dev includes stack", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";

  const app = patchAppForAsyncErrors(express());
  app.get("/sync", () => {
    throw new Error("boom");
  });
  app.use(globalErrorHandler);

  const { url, close } = await start(app);
  const res = await fetch(`${url}/sync`);
  const json = await res.json();

  assert.equal(res.status, 500);
  assert.equal(json.error, "Internal server error");
  assert.equal(typeof json.requestId, "string");
  assert.equal(typeof json.stack, "string");
  assert.ok(json.stack.length >= 0);

  await close();
  process.env.NODE_ENV = prev;
});
