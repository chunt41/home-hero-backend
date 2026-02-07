import test from "node:test";
import assert from "node:assert/strict";

import { sendExpoPush } from "./expoPush";

function makeResponse(params: {
  ok: boolean;
  status: number;
  json?: any;
  text?: string;
}) {
  return {
    ok: params.ok,
    status: params.status,
    json: async () => params.json,
    text: async () => params.text ?? "",
  } as any;
}

test("expo push: invalid/unregistered token deletes from DB immediately (ticket error)", async () => {
  const deleted: any[] = [];
  const prisma = {
    pushToken: {
      deleteMany: async (args: any) => {
        deleted.push(args);
        return { count: 1 };
      },
    },
  };

  const fetchCalls: any[] = [];
  const fetch = async (url: string, init: any) => {
    fetchCalls.push({ url, init });
    return makeResponse({
      ok: true,
      status: 200,
      json: {
        data: [
          {
            status: "error",
            message: "The device is not registered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      },
    });
  };

  await sendExpoPush(
    [
      {
        to: "ExponentPushToken[invalid]",
        userId: 123,
        title: "t",
        body: "b",
      },
    ],
    { prisma, fetch, maxRetries: 0, sleep: async () => {} }
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0].where.token.in, ["ExponentPushToken[invalid]"]);
});

test("expo push: transient HTTP error retries with backoff and succeeds", async () => {
  let call = 0;
  const sleeps: number[] = [];

  const fetch = async () => {
    call += 1;
    if (call === 1) {
      return makeResponse({ ok: false, status: 503, text: "Service Unavailable" });
    }

    return makeResponse({
      ok: true,
      status: 200,
      json: { data: [{ status: "ok", id: "ticket-1" }] },
    });
  };

  const fetchReceipts = async (url: string) => {
    if (url.includes("getReceipts")) {
      return makeResponse({ ok: true, status: 200, json: { data: { "ticket-1": { status: "ok" } } } });
    }
    return fetch();
  };

  await sendExpoPush(
    [
      {
        to: "ExponentPushToken[ok]",
        userId: 1,
        title: "t",
        body: "b",
      },
    ],
    {
      fetch: fetchReceipts as any,
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }
  );

  assert.equal(call, 2);
  assert.ok(sleeps.length >= 1);
});

test("expo push: invalid/unregistered token deletes from DB when receipt reports error", async () => {
  const deleted: any[] = [];
  const prisma = {
    pushToken: {
      deleteMany: async (args: any) => {
        deleted.push(args);
        return { count: 1 };
      },
    },
  };

  const fetchCalls: string[] = [];
  const fetch = async (url: string) => {
    fetchCalls.push(url);
    if (url.includes("/push/send")) {
      return makeResponse({
        ok: true,
        status: 200,
        json: { data: [{ status: "ok", id: "ticket-abc" }] },
      });
    }

    if (url.includes("/push/getReceipts")) {
      return makeResponse({
        ok: true,
        status: 200,
        json: {
          data: {
            "ticket-abc": {
              status: "error",
              message: "The device is not registered",
              details: { error: "DeviceNotRegistered" },
            },
          },
        },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  await sendExpoPush(
    [
      {
        to: "ExponentPushToken[invalid-receipt]",
        userId: 123,
        title: "t",
        body: "b",
      },
    ],
    { prisma, fetch: fetch as any, maxRetries: 0, sleep: async () => {} }
  );

  assert.equal(fetchCalls.length, 2);
  assert.ok(fetchCalls[0].includes("/push/send"));
  assert.ok(fetchCalls[1].includes("/push/getReceipts"));

  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0].where.token.in, ["ExponentPushToken[invalid-receipt]"]);
});

test("expo push: permanent failure is dead-lettered when enabled", async () => {
  const events: any[] = [];
  const prisma = {
    securityEvent: {
      create: async (args: any) => {
        events.push(args);
        return { id: 1 };
      },
    },
  };

  const fetch = async (url: string) => {
    if (!url.includes("/push/send")) throw new Error(`Unexpected URL: ${url}`);

    return makeResponse({
      ok: true,
      status: 200,
      json: {
        data: [
          {
            status: "error",
            message: "Invalid credentials",
            details: { error: "InvalidCredentials" },
          },
        ],
      },
    });
  };

  await sendExpoPush(
    [
      {
        to: "ExponentPushToken[permfail]",
        userId: 77,
        title: "t",
        body: "b",
      },
    ],
    {
      prisma,
      fetch: fetch as any,
      maxRetries: 0,
      sleep: async () => {},
      deadLetter: { enabled: true },
    }
  );

  assert.equal(events.length, 1);
  const ev = events[0]?.data;
  assert.equal(ev.actionType, "push.deadletter");
  assert.equal(ev.actorUserId, 77);
  assert.equal(ev.targetType, "PUSH_TOKEN");
  assert.equal(ev.targetId, "ExponentPushToken[permfail]");
  assert.equal(ev.metadataJson?.errorCode, "InvalidCredentials");
});
