import test from "node:test";
import assert from "node:assert/strict";

import { scrubSentryEvent, scrubStringPII } from "./sentryScrubber";

test("scrubStringPII masks email addresses", () => {
  const out = scrubStringPII("Contact me at chris.scott@example.com");
  assert.equal(out, "Contact me at c***@example.com");
});

test("scrubStringPII masks phone numbers", () => {
  const out = scrubStringPII("Call (415) 555-1212 asap");
  assert.equal(out, "Call [REDACTED_PHONE] asap");
});

test("scrubSentryEvent removes auth headers and cookies", () => {
  const event: any = {
    message: "User chris.scott@example.com called 415-555-1212",
    request: {
      headers: {
        Authorization: "Bearer secret.token.value",
        cookie: "sid=abc123",
        "X-Stripe-Signature": "t=123,v1=abc",
      },
      cookies: { sid: "abc123" },
      data: { email: "chris.scott@example.com", phone: "+1 415 555 1212" },
    },
  };

  const out = scrubSentryEvent(event);

  assert.ok(!out.request.headers.Authorization);
  assert.ok(!out.request.headers.cookie);
  assert.ok(!out.request.headers["X-Stripe-Signature"]);
  assert.ok(!("cookies" in out.request));
  assert.equal(out.message, "User c***@example.com called [REDACTED_PHONE]");
  assert.deepEqual(out.request.data, { email: "c***@example.com", phone: "[REDACTED_PHONE]" });
});
