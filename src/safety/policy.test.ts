import test from "node:test";
import assert from "node:assert/strict";

import {
  computeEscalatingRestrictionMinutes,
  decideRestrictionFromRecentSecurityEvents,
} from "./policy";

test("safety policy: escalating restriction minutes", () => {
  assert.equal(computeEscalatingRestrictionMinutes({ violationCountIncludingThis: 1 }), null);
  assert.equal(computeEscalatingRestrictionMinutes({ violationCountIncludingThis: 2 }), null);
  assert.equal(computeEscalatingRestrictionMinutes({ violationCountIncludingThis: 3 }), 30);
  assert.equal(computeEscalatingRestrictionMinutes({ violationCountIncludingThis: 5 }), 6 * 60);
  assert.equal(computeEscalatingRestrictionMinutes({ violationCountIncludingThis: 8 }), 24 * 60);
});

test("safety policy: restriction decision based on SecurityEvent counts", async () => {
  const prisma = {
    securityEvent: {
      count: async () => 3,
    },
  };

  const out = await decideRestrictionFromRecentSecurityEvents({
    prisma,
    actorUserId: 123,
    actionType: "message.blocked",
    windowMinutes: 10,
    reason: "repeated_message_blocks",
  });

  assert.equal(out.action, "RESTRICT");
  if (out.action !== "RESTRICT") throw new Error("expected RESTRICT");

  // ~30 minutes
  const minutes = (out.restrictedUntil.getTime() - Date.now()) / 60_000;
  assert.ok(minutes > 20 && minutes < 40);
  assert.equal(out.minutes, 30);
});
