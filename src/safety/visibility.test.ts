import test from "node:test";
import assert from "node:assert/strict";

import { messageWhereVisible, jobWhereVisible, userWhereVisible } from "./visibility";

test("visibility: non-admin sees only non-hidden jobs", () => {
  const where = jobWhereVisible({ user: { userId: 1, role: "CONSUMER" } });
  assert.equal(where.isHidden, false);
});

test("visibility: non-admin sees own hidden messages only", () => {
  const where = messageWhereVisible({ user: { userId: 10, role: "CONSUMER" } });
  assert.deepEqual(where, { OR: [{ isHidden: false }, { senderId: 10 }] });
});

test("visibility: admin sees hidden content", () => {
  assert.deepEqual(messageWhereVisible({ user: { userId: 99, role: "ADMIN" } }), {});
  assert.deepEqual(jobWhereVisible({ user: { userId: 99, role: "ADMIN" } }), {});
  assert.deepEqual(userWhereVisible({ user: { userId: 99, role: "ADMIN" } }), {});
});
