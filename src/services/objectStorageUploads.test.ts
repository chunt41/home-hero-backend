import test from "node:test";
import assert from "node:assert/strict";

import { computeNewUploadTargets } from "./objectStorageUploads";

test("new upload stores storageKey in production", () => {
  const storageProvider = {
    putObject: async () => {},
    getSignedReadUrl: async () => "",
    deleteObject: async () => {},
  };

  const out = computeNewUploadTargets({
    namespace: "message",
    ownerId: 123,
    basename: "file.png",
    storageProvider: storageProvider as any,
    nodeEnv: "production",
  });

  assert.equal(out.diskPath, null);
  assert.equal(out.storageKey, "attachments/message/123/file.png");
});
