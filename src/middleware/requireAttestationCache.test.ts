import test from "node:test";
import assert from "node:assert/strict";

import { createRequireAttestation } from "./requireAttestation";

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function makeJwtLike(payload: Record<string, unknown>): string {
  const header = { alg: "none", typ: "JWT" };
  return `${b64urlJson(header)}.${b64urlJson(payload)}.sig`;
}

function makeReq(headers: Record<string, string | undefined> = {}, userId = 42) {
  return {
    path: "/sensitive",
    method: "POST",
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    header(name: string) {
      return (this.headers as any)[String(name).toLowerCase()];
    },
    ip: "127.0.0.1",
    user: { userId, role: "CONSUMER" },
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

function createMemoryRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const calls = {
    get: 0,
    set: 0,
    pxValues: [] as Array<number | undefined>,
  };

  return {
    calls,
    redis: {
      async get(key: string) {
        calls.get += 1;
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
          store.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key: string, value: string, opts?: { PX?: number }) {
        calls.set += 1;
        calls.pxValues.push(opts?.PX);
        store.set(key, {
          value,
          expiresAt: opts?.PX ? Date.now() + opts.PX : undefined,
        });
        return "OK";
      },
    },
  };
}

test("requireAttestation cache: second request within TTL uses cache", async () => {
  const oldEnv = { ...process.env };
  process.env.APP_ATTESTATION_ENFORCE = "true";
  process.env.ALLOW_UNATTESTED_DEV = "false";
  process.env.NODE_ENV = "production";

  const { redis, calls } = createMemoryRedis();
  let verifyCalls = 0;

  const token = makeJwtLike({ deviceId: "device-1", platform: "ios" });

  const mw = createRequireAttestation({
    redis,
    verifyIos: async () => {
      verifyCalls += 1;
      return {
        attested: true,
        attestation: {
          platform: "ios",
          deviceId: "device-1",
          issuedAt: new Date().toISOString(),
          riskLevel: "low",
        },
      };
    },
  });

  const infoCalls: unknown[][] = [];
  const oldInfo = console.info;
  console.info = (...args: unknown[]) => {
    infoCalls.push(args);
  };

  const req1 = makeReq({
    "x-app-platform": "ios",
    "x-app-attestation": token,
  });
  const res1 = makeRes();
  const r1 = await runMiddleware(mw, req1, res1);

  assert.equal(r1.nextCalled, true);
  assert.equal(req1.attested, true);
  assert.equal(verifyCalls, 1);

  const req2 = makeReq({
    "x-app-platform": "ios",
    "x-app-attestation": token,
  });
  const res2 = makeRes();
  const r2 = await runMiddleware(mw, req2, res2);

  assert.equal(r2.nextCalled, true);
  assert.equal(req2.attested, true);
  assert.equal(req2.attestation?.deviceId, "device-1");
  assert.equal(verifyCalls, 1, "verifier should not run on cache hit");

  assert.ok(calls.get >= 1);
  assert.ok(calls.set >= 1);
  assert.ok(calls.pxValues.every((px) => px === 600_000));

  // Ensure we never log the raw attestation token.
  const logged = infoCalls.map((a) => a.map((x) => String(x)).join(" ")).join("\n");
  assert.equal(logged.includes(token), false);

  console.info = oldInfo;

  for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete (process.env as any)[k];
  for (const [k, v] of Object.entries(oldEnv)) process.env[k] = v;
});
