import test from "node:test";
import assert from "node:assert/strict";

import { requireAttestation } from "./requireAttestation";

function makeReq(headers: Record<string, string | undefined> = {}) {
  return {
    path: "/sensitive",
    method: "POST",
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
    header(name: string) {
      return (this.headers as any)[String(name).toLowerCase()];
    },
    ip: "127.0.0.1",
  } as any;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(k: string, v: string) {
      this.headers[String(k).toLowerCase()] = String(v);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function runMiddleware(req: any, res: any) {
  let nextCalled = false;
  await requireAttestation(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled };
}

test("requireAttestation decision: enforcement OFF behaves as today", async () => {
  const oldEnforce = process.env.APP_ATTESTATION_ENFORCE;
  process.env.APP_ATTESTATION_ENFORCE = "false";

  const req = makeReq({});
  const res = makeRes();
  const { nextCalled } = await runMiddleware(req, res);

  assert.equal(nextCalled, true);
  assert.equal(req.attested, false);

  process.env.APP_ATTESTATION_ENFORCE = oldEnforce;
});

test("requireAttestation decision: dev bypass allowed in non-production", async () => {
  const oldEnforce = process.env.APP_ATTESTATION_ENFORCE;
  const oldBypass = process.env.ALLOW_UNATTESTED_DEV;
  const oldNodeEnv = process.env.NODE_ENV;

  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.ALLOW_UNATTESTED_DEV = "true";
  process.env.NODE_ENV = "test";

  const req = makeReq({});
  const res = makeRes();
  const { nextCalled } = await runMiddleware(req, res);

  assert.equal(nextCalled, true);
  assert.equal(req.attested, false);

  process.env.APP_ATTESTATION_ENFORCE = oldEnforce;
  process.env.ALLOW_UNATTESTED_DEV = oldBypass;
  process.env.NODE_ENV = oldNodeEnv;
});

test("requireAttestation decision: enforcement ON in production rejects missing token", async () => {
  const oldEnforce = process.env.APP_ATTESTATION_ENFORCE;
  const oldBypass = process.env.ALLOW_UNATTESTED_DEV;
  const oldNodeEnv = process.env.NODE_ENV;

  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.ALLOW_UNATTESTED_DEV = "false";
  process.env.NODE_ENV = "production";

  const req = makeReq({ "x-app-platform": "android" });
  const res = makeRes();

  const oldWarn = console.warn;
  console.warn = () => {};
  const { nextCalled } = await runMiddleware(req, res);
  console.warn = oldWarn;

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(typeof res.body?.error, "string");
  assert.match(res.body.error, /attestation required/i);

  process.env.APP_ATTESTATION_ENFORCE = oldEnforce;
  process.env.ALLOW_UNATTESTED_DEV = oldBypass;
  process.env.NODE_ENV = oldNodeEnv;
});
