import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { z } from "zod";
import type { AddressInfo } from "node:net";

import { validate } from "./validate";

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", (err) => reject(err));
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("validate() returns 400 with error+details", async () => {
  const app = express();
  app.use(express.json());

  app.post(
    "/demo",
    validate({ body: z.object({ name: z.string().min(1) }) }),
    (_req, res) => res.json({ ok: true })
  );

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(resp.status, 400);
    const json = await resp.json();

    assert.equal(json.error, "Validation failed");
    assert.ok(Array.isArray(json.details));
    assert.ok(json.details.length >= 1);
    assert.ok(json.details.some((d: any) => Array.isArray(d.path) && d.message));
  });
});

test("validate() coerces params and exposes req.validated", async () => {
  const app = express();
  app.use(express.json());

  app.post(
    "/items/:id",
    validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
    (req, res) => {
      const id = (req as any).validated.params.id;
      res.json({ id, type: typeof id });
    }
  );

  await withServer(app, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/items/123`, { method: "POST" });
    assert.equal(resp.status, 200);

    const json = await resp.json();
    assert.equal(json.id, 123);
    assert.equal(json.type, "number");
  });
});

test("validate() enforces events max length (50)", async () => {
  const app = express();
  app.use(express.json());

  const eventsSchema = z
    .array(z.string())
    .transform((events) =>
      Array.from(
        new Set(
          events
            .map((e) => String(e).trim())
            .filter((e) => e.length > 0)
        )
      )
    )
    .refine((events) => events.length <= 50, {
      message: "events must contain at most 50 entries",
    })
    .refine((events) => events.every((e) => e.length <= 100), {
      message: "each event must be at most 100 characters",
    })
    .refine((events) => events.length > 0, {
      message: "events[] is required",
    });

  app.post(
    "/demo-webhooks",
    validate({ body: z.object({ url: z.string().min(1), events: eventsSchema }) }),
    (_req, res) => res.json({ ok: true })
  );

  await withServer(app, async (baseUrl) => {
    const tooManyUniqueEvents = Array.from({ length: 51 }, (_, i) => `event.${i}`);

    const resp = await fetch(`${baseUrl}/demo-webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", events: tooManyUniqueEvents }),
    });

    assert.equal(resp.status, 400);
    const json = await resp.json();

    assert.equal(json.error, "Validation failed");
    assert.ok(Array.isArray(json.details));
    assert.ok(json.details.some((d: any) => typeof d?.message === "string" && d.message.includes("at most 50")));
  });
});

test("validate() enforces events item max length (100 chars)", async () => {
  const app = express();
  app.use(express.json());

  const eventsSchema = z
    .array(z.string())
    .transform((events) =>
      Array.from(
        new Set(
          events
            .map((e) => String(e).trim())
            .filter((e) => e.length > 0)
        )
      )
    )
    .refine((events) => events.length <= 50, {
      message: "events must contain at most 50 entries",
    })
    .refine((events) => events.every((e) => e.length <= 100), {
      message: "each event must be at most 100 characters",
    })
    .refine((events) => events.length > 0, {
      message: "events[] is required",
    });

  app.post(
    "/demo-webhooks",
    validate({ body: z.object({ url: z.string().min(1), events: eventsSchema }) }),
    (_req, res) => res.json({ ok: true })
  );

  await withServer(app, async (baseUrl) => {
    const tooLong = "x".repeat(101);

    const resp = await fetch(`${baseUrl}/demo-webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", events: [tooLong] }),
    });

    assert.equal(resp.status, 400);
    const json = await resp.json();

    assert.equal(json.error, "Validation failed");
    assert.ok(Array.isArray(json.details));
    assert.ok(
      json.details.some((d: any) => typeof d?.message === "string" && d.message.includes("100 characters"))
    );
  });
});
