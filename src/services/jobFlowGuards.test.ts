import test from "node:test";
import assert from "node:assert/strict";

import { canOpenDispute, canReviewJob } from "./jobFlowGuards";

test("canReviewJob allows only COMPLETED", () => {
  assert.equal(canReviewJob("IN_PROGRESS"), false);
  assert.equal(canReviewJob("COMPLETED_PENDING_CONFIRMATION"), false);
  assert.equal(canReviewJob("COMPLETED"), true);
});

test("canOpenDispute allows completion pending or completed", () => {
  assert.equal(canOpenDispute("OPEN"), false);
  assert.equal(canOpenDispute("IN_PROGRESS"), false);
  assert.equal(canOpenDispute("COMPLETED_PENDING_CONFIRMATION"), true);
  assert.equal(canOpenDispute("COMPLETED"), true);
  assert.equal(canOpenDispute("CANCELLED"), false);
});
