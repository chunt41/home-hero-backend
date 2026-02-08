import test from "node:test";
import assert from "node:assert/strict";

import { initSentry } from "./sentry";

test("initSentry is a no-op when SENTRY_DSN missing", async () => {
  const prev = process.env.SENTRY_DSN;
  try {
    delete process.env.SENTRY_DSN;
    await assert.doesNotReject(async () => {
      await initSentry();
    });
  } finally {
    if (typeof prev === "string") process.env.SENTRY_DSN = prev;
    else delete process.env.SENTRY_DSN;
  }
});
