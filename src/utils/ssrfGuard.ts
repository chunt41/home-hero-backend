import { isIP } from "node:net";

const URL_NOT_ALLOWED_MESSAGE = "URL not allowed";

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

export type DnsLookupAll = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>;

const DISALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function isPrivateOrInternalIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 => 172.16.0.0 - 172.31.255.255
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

function ipv4ToHextets(ip: string): [string, string] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const hi = ((octets[0] << 8) | octets[1]).toString(16);
  const lo = ((octets[2] << 8) | octets[3]).toString(16);
  return [hi, lo];
}

function parseIPv6ToBigInt(ip: string): bigint | null {
  const withoutZone = ip.split("%")[0].toLowerCase();

  let input = withoutZone;
  // Handle embedded IPv4 (e.g. ::ffff:192.168.0.1)
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4Part = input.slice(lastColon + 1);
    const mapped = ipv4ToHextets(ipv4Part);
    if (!mapped) return null;
    input = `${input.slice(0, lastColon)}:${mapped[0]}:${mapped[1]}`;
  }

  const [headRaw, tailRaw] = input.split("::");
  const head = headRaw ? headRaw.split(":").filter(Boolean) : [];
  const tail = tailRaw !== undefined ? (tailRaw ? tailRaw.split(":").filter(Boolean) : []) : [];

  if (input.includes("::")) {
    if (head.length + tail.length > 8) return null;
  } else {
    if (head.length !== 8) return null;
  }

  const missing = input.includes("::") ? 8 - (head.length + tail.length) : 0;
  const parts = [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
  if (parts.length !== 8) return null;

  let value = 0n;
  for (const part of parts) {
    if (part.length === 0 || part.length > 4) return null;
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    const n = BigInt(parseInt(part, 16));
    value = (value << 16n) | n;
  }
  return value;
}

function isPrivateOrInternalIPv6(ip: string): boolean {
  const big = parseIPv6ToBigInt(ip);
  if (big === null) return false;

  // ::1/128 (loopback)
  if (big === 1n) return true;

  // fc00::/7 => first byte 0xfc or 0xfd
  const firstByte = Number((big >> 120n) & 0xffn);
  if (firstByte === 0xfc || firstByte === 0xfd) return true;

  // fe80::/10 => fe80 - febf in the first 16 bits
  const first16 = Number((big >> 112n) & 0xffffn);
  if (first16 >= 0xfe80 && first16 <= 0xfebf) return true;

  return false;
}

function isPrivateOrInternalIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateOrInternalIPv4(ip);
  if (family === 6) return isPrivateOrInternalIPv6(ip);
  return false;
}

function isExplicitlyDisallowedHostname(hostname: string): boolean {
  return DISALLOWED_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validates and normalizes a webhook endpoint URL with SSRF mitigations:
 * - http(s) only (https only in production)
 * - blocks localhost/loopback-ish names
 * - blocks private/internal IP ranges
 * - DNS resolves hostnames and blocks if any resolved IP is private/internal
 */
export async function validateAndNormalizeWebhookUrl(
  url: unknown,
  options?: {
    nodeEnv?: string;
    dnsLookupAll?: DnsLookupAll;
  }
): Promise<string> {
  if (typeof url !== "string") {
    throw new UrlValidationError("url is required");
  }

  const trimmed = url.trim();
  if (!trimmed) {
    throw new UrlValidationError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UrlValidationError("url must be a valid URL");
  }

  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const isProd = nodeEnv === "production";
  const protocol = parsed.protocol;

  if (isProd) {
    if (protocol !== "https:") {
      throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
    }
  } else {
    if (protocol !== "http:" && protocol !== "https:") {
      throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
    }
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new UrlValidationError("url must include a hostname");
  }

  if (isExplicitlyDisallowedHostname(hostname)) {
    throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
  }

  // If URL contains an IP literal, validate directly.
  if (isIP(hostname)) {
    if (isPrivateOrInternalIp(hostname)) {
      throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
    }
    return parsed.toString();
  }

  const dnsLookupAll = options?.dnsLookupAll;

  let records: Array<{ address: string; family: number }>;
  try {
    if (!dnsLookupAll) {
      const dns = await import("node:dns/promises");
      records = await (dns.lookup as any)(hostname, { all: true, verbatim: true });
    } else {
      records = await dnsLookupAll(hostname, { all: true, verbatim: true });
    }
  } catch {
    throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
  }

  if (!records || records.length === 0) {
    throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
  }

  for (const rec of records) {
    const addr = rec.address;
    if (isExplicitlyDisallowedHostname(addr)) {
      throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
    }
    if (isPrivateOrInternalIp(addr)) {
      throw new UrlValidationError(URL_NOT_ALLOWED_MESSAGE);
    }
  }

  return parsed.toString();
}
