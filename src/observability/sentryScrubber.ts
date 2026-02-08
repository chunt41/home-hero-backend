export function maskEmailLocalPart(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "[REDACTED_EMAIL]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "[REDACTED_EMAIL]";
  const first = local.slice(0, 1) || "*";
  return `${first}***@${domain}`;
}

export function scrubStringPII(input: string): string {
  let s = input;

  // Emails
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskEmailLocalPart(m));

  // Phone numbers (coarse but effective)
  s = s.replace(
    /(?<!\w)(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\w)/g,
    "[REDACTED_PHONE]"
  );

  return s;
}

export function scrubAny(value: unknown): unknown {
  if (typeof value === "string") return scrubStringPII(value);
  if (Array.isArray(value)) return value.map(scrubAny);
  if (!value || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = scrubAny(v);
  }
  return out;
}

export function scrubSentryEvent(event: any): any {
  if (!event || typeof event !== "object") return event;

  if (typeof event.message === "string") event.message = scrubStringPII(event.message);
  if (typeof event.logentry?.message === "string") event.logentry.message = scrubStringPII(event.logentry.message);

  if (event.exception?.values && Array.isArray(event.exception.values)) {
    for (const ex of event.exception.values) {
      if (typeof ex?.value === "string") ex.value = scrubStringPII(ex.value);
      if (typeof ex?.type === "string") ex.type = scrubStringPII(ex.type);
    }
  }

  const headers = event.request?.headers;
  if (headers && typeof headers === "object") {
    const h = headers as Record<string, unknown>;
    for (const key of [
      "authorization",
      "Authorization",
      "cookie",
      "Cookie",
      "set-cookie",
      "Set-Cookie",
      "x-api-key",
      "X-Api-Key",
      "x-stripe-signature",
      "X-Stripe-Signature",
      "x-gogetter-signature",
      "X-GoGetter-Signature",
    ]) {
      if (key in h) delete h[key];
    }
  }

  if (event.request && "cookies" in event.request) {
    delete event.request.cookies;
  }

  if (event.request?.data !== undefined) event.request.data = scrubAny(event.request.data);
  if (event.extra !== undefined) event.extra = scrubAny(event.extra);

  if (Array.isArray(event.breadcrumbs)) {
    for (const b of event.breadcrumbs) {
      if (typeof b?.message === "string") b.message = scrubStringPII(b.message);
      if (b?.data !== undefined) b.data = scrubAny(b.data);
    }
  }

  if (event.user && typeof event.user === "object") {
    const u = event.user as Record<string, unknown>;
    for (const key of ["email", "username", "ip_address"]) {
      if (typeof u[key] === "string") u[key] = scrubStringPII(String(u[key]));
    }
  }

  return event;
}
