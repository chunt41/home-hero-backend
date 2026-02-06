import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import { canAccessJobAttachment, resolveDiskPathInsideUploadsDir } from "./attachmentsGuard";

test("authorization: consumer who owns job allowed", () => {
  assert.equal(
    canAccessJobAttachment({
      requesterRole: "CONSUMER",
      requesterUserId: 10,
      jobConsumerId: 10,
      requesterHasBidOnJob: false,
    }),
    true
  );
});

test("authorization: provider with bid allowed", () => {
  assert.equal(
    canAccessJobAttachment({
      requesterRole: "PROVIDER",
      requesterUserId: 22,
      jobConsumerId: 10,
      requesterHasBidOnJob: true,
    }),
    true
  );
});

test("authorization: admin allowed", () => {
  assert.equal(
    canAccessJobAttachment({
      requesterRole: "ADMIN",
      requesterUserId: 99,
      jobConsumerId: 10,
      requesterHasBidOnJob: false,
    }),
    true
  );
});

test("authorization: provider without bid denied", () => {
  assert.equal(
    canAccessJobAttachment({
      requesterRole: "PROVIDER",
      requesterUserId: 22,
      jobConsumerId: 10,
      requesterHasBidOnJob: false,
    }),
    false
  );
});

test("path traversal: allows child path", () => {
  const uploadsDir = path.join(os.tmpdir(), "uploads-test");
  const abs = resolveDiskPathInsideUploadsDir(uploadsDir, "attachments/file.jpg");
  assert.ok(abs.includes(path.join("uploads-test", "attachments")));
});

test("path traversal: blocks .. escape", () => {
  const uploadsDir = path.join(os.tmpdir(), "uploads-test");
  assert.throws(() => resolveDiskPathInsideUploadsDir(uploadsDir, "../secrets.txt"));
  assert.throws(() => resolveDiskPathInsideUploadsDir(uploadsDir, "attachments/../../secrets.txt"));
});

test("path traversal: blocks absolute diskPath", () => {
  const uploadsDir = path.join(os.tmpdir(), "uploads-test");
  const absPath = path.join(uploadsDir, "attachments", "file.jpg");
  assert.throws(() => resolveDiskPathInsideUploadsDir(uploadsDir, absPath));
});
