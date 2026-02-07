import test from "node:test";
import assert from "node:assert/strict";

import { createRequireAttestation } from "./requireAttestation";

function makeReq(headers: Record<string, string | undefined> = {}) {
  return {
    path: "/sensitive",
    method: "POST",
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
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

async function runMiddleware(mw: any, req: any, res: any) {
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled };
}

test("requireAttestation routing: ios uses iOS verifier", async () => {
  const oldEnv = { ...process.env };
  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.ALLOW_UNATTESTED_DEV = "false";
  process.env.NODE_ENV = "production";

  let iosCalls = 0;
  let androidCalls = 0;

  const mw = createRequireAttestation({
    verifyIos: async () => {
      iosCalls += 1;
      return {
        attested: true,
        attestation: {
          platform: "ios",
          deviceId: "ios-device",
          issuedAt: new Date().toISOString(),
          riskLevel: "low",
        },
      };
    },
    verifyAndroid: async () => {
      androidCalls += 1;
      throw new Error("should not be called");
    },
  });

  const req = makeReq({
    "x-app-platform": "ios",
    "x-app-attestation": "some-ios-token",
  });
  const res = makeRes();
  const { nextCalled } = await runMiddleware(mw, req, res);

  assert.equal(nextCalled, true);
  assert.equal(req.attested, true);
  assert.equal(req.attestation?.platform, "ios");
  assert.equal(iosCalls, 1);
  assert.equal(androidCalls, 0);

  for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete (process.env as any)[k];
  for (const [k, v] of Object.entries(oldEnv)) process.env[k] = v;
});

test("requireAttestation routing: android uses Android verifier", async () => {
  const oldEnv = { ...process.env };
  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.ALLOW_UNATTESTED_DEV = "false";
  process.env.NODE_ENV = "production";

  let iosCalls = 0;
  let androidCalls = 0;

  const mw = createRequireAttestation({
    verifyIos: async () => {
      iosCalls += 1;
      throw new Error("should not be called");
    },
    verifyAndroid: async () => {
      androidCalls += 1;
      return {
        attested: true,
        attestation: {
          platform: "android",
          deviceId: "android-device",
          issuedAt: new Date().toISOString(),
          riskLevel: "low",
        },
      };
    },
  });

  const req = makeReq({
    "x-app-platform": "android",
    "x-app-attestation": "some-android-token",
  });
  const res = makeRes();
  const { nextCalled } = await runMiddleware(mw, req, res);

  assert.equal(nextCalled, true);
  assert.equal(req.attested, true);
  assert.equal(req.attestation?.platform, "android");
  assert.equal(androidCalls, 1);
  assert.equal(iosCalls, 0);

  for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete (process.env as any)[k];
  for (const [k, v] of Object.entries(oldEnv)) process.env[k] = v;
});
