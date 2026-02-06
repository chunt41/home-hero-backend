import test from "node:test";
import assert from "node:assert/strict";

import { UrlValidationError, validateAndNormalizeWebhookUrl } from "./ssrfGuard";

test("public https URL OK", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const normalized = await validateAndNormalizeWebhookUrl("https://example.com/webhook", {
    dnsLookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(normalized, "https://example.com/webhook");

  process.env.NODE_ENV = oldEnv;
});

test("http allowed in non-prod", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";

  const normalized = await validateAndNormalizeWebhookUrl("http://example.com/webhook", {
    dnsLookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  assert.equal(normalized, "http://example.com/webhook");

  process.env.NODE_ENV = oldEnv;
});

test("http blocked in prod", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () => validateAndNormalizeWebhookUrl("http://example.com/webhook"),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});

test("localhost blocked", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () => validateAndNormalizeWebhookUrl("https://localhost/webhook"),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});

test("private IP blocked", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () => validateAndNormalizeWebhookUrl("https://10.1.2.3/webhook"),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});

test("hostname resolving to private blocked (mock dns)", async (t) => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () =>
      validateAndNormalizeWebhookUrl("https://evil.test/webhook", {
        dnsLookupAll: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});

test("blocks other private IPv4 ranges", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  for (const ip of ["172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.10.10", "127.0.0.2"]) {
    await assert.rejects(
      () => validateAndNormalizeWebhookUrl(`https://${ip}/webhook`),
      (err: any) => {
        assert.ok(err instanceof UrlValidationError);
        assert.equal(String(err.message), "URL not allowed");
        return true;
      }
    );
  }

  process.env.NODE_ENV = oldEnv;
});

test("blocks private/local IPv6 literals", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  for (const ip of ["::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd00::1", "fe80::1"]) {
    await assert.rejects(
      () => validateAndNormalizeWebhookUrl(`https://[${ip}]/webhook`),
      (err: any) => {
        assert.ok(err instanceof UrlValidationError);
        assert.equal(String(err.message), "URL not allowed");
        return true;
      }
    );
  }

  process.env.NODE_ENV = oldEnv;
});

test("hostname resolving to private IPv6 blocked (mock dns)", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () =>
      validateAndNormalizeWebhookUrl("https://evil6.test/webhook", {
        dnsLookupAll: async () => [{ address: "fe80::1", family: 6 }],
      }),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});

test("hostname with mixed DNS answers: any private blocks", async () => {
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  await assert.rejects(
    () =>
      validateAndNormalizeWebhookUrl("https://mixed.test/webhook", {
        dnsLookupAll: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      }),
    (err: any) => {
      assert.ok(err instanceof UrlValidationError);
      assert.equal(String(err.message), "URL not allowed");
      return true;
    }
  );

  process.env.NODE_ENV = oldEnv;
});
