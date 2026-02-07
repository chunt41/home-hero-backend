import test from "node:test";
import assert from "node:assert/strict";

import { shouldSendNotification } from "./notificationPreferences";

test("shouldSendNotification: disabled toggle suppresses", () => {
  const allowed = shouldSendNotification(
    {
      userId: 1,
      jobMatchEnabled: false,
      bidEnabled: true,
      messageEnabled: true,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "UTC",
    },
    "JOB_MATCH",
    new Date("2025-01-01T12:00:00Z")
  );

  assert.equal(allowed, false);
});

test("shouldSendNotification: quiet hours suppresses (non-wrapping)", () => {
  const allowed = shouldSendNotification(
    {
      userId: 1,
      jobMatchEnabled: true,
      bidEnabled: true,
      messageEnabled: true,
      quietHoursStart: "09:00",
      quietHoursEnd: "17:00",
      timezone: "UTC",
    },
    "MESSAGE",
    new Date("2025-01-01T12:00:00Z")
  );

  assert.equal(allowed, false);
});

test("shouldSendNotification: quiet hours suppresses (wraps midnight)", () => {
  // 2025-01-01T04:00Z is 23:00 on 2024-12-31 in America/New_York (winter)
  const allowed = shouldSendNotification(
    {
      userId: 1,
      jobMatchEnabled: true,
      bidEnabled: true,
      messageEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/New_York",
    },
    "BID",
    new Date("2025-01-01T04:00:00Z")
  );

  assert.equal(allowed, false);
});

test("shouldSendNotification: outside quiet hours allows", () => {
  // 2025-01-01T15:00Z is 10:00 in America/New_York
  const allowed = shouldSendNotification(
    {
      userId: 1,
      jobMatchEnabled: true,
      bidEnabled: true,
      messageEnabled: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      timezone: "America/New_York",
    },
    "JOB_MATCH",
    new Date("2025-01-01T15:00:00Z")
  );

  assert.equal(allowed, true);
});
