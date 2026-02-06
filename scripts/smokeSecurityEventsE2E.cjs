require("dotenv/config");

const { PrismaClient, Prisma } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const baseUrl = (process.env.SMOKE_BASE_URL || "http://localhost:4010").replace(/\/$/, "");
const actorEmail = process.env.SMOKE_EMAIL || "smoke-test-nobody@example.com";

const connectionString =
  process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_PRIVATE_URL or DATABASE_URL must be set");
}

const caPath = path.join(process.cwd(), "certs", "supabase-ca.crt");
const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath, "utf8") : undefined;

const pool = new Pool({
  connectionString,
  ssl: ca
    ? {
        ca,
        rejectUnauthorized: true,
      }
    : {
        rejectUnauthorized: false,
      },
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postLoginFailure() {
  const url = `${baseUrl}/auth/login`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: actorEmail, password: "not-the-password" }),
  });

  const text = await res.text().catch(() => "");
  return { status: res.status, body: text };
}

async function findRecentLoginFailedEvent({ since }) {
  return prisma.securityEvent.findFirst({
    where: {
      actionType: "auth.login_failed",
      actorEmail,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      actionType: true,
      actorUserId: true,
      actorRole: true,
      actorEmail: true,
      ip: true,
      userAgent: true,
      metadataJson: true,
      createdAt: true,
    },
  });
}

async function fetchSecurityEventsAsAdmin() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return { ok: false, reason: "JWT_SECRET missing" };
  }

  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, role: true },
    orderBy: { id: "asc" },
  });

  if (!admin) {
    return { ok: false, reason: "No ADMIN user found" };
  }

  const token = jwt.sign({ userId: admin.id, role: admin.role }, secret, {
    expiresIn: "5m",
  });

  const url = `${baseUrl}/admin/security-events?actionType=${encodeURIComponent(
    "auth.login_failed"
  )}&take=50`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}`, response: json };
  }

  const events = Array.isArray(json?.events) ? json.events : [];
  const hit = events.find((e) => e?.actorEmail === actorEmail);

  return {
    ok: true,
    adminUserId: admin.id,
    status: res.status,
    hasEventForEmail: Boolean(hit),
    totalReturned: events.length,
  };
}

async function main() {
  const since = new Date(Date.now() - 2 * 60 * 1000);

  // Give the server a moment if it was just started.
  await sleep(750);

  const login = await postLoginFailure();

  // Allow async logging to flush.
  await sleep(750);

  const dbEvent = await findRecentLoginFailedEvent({ since });
  const api = await fetchSecurityEventsAsAdmin();

  const ok = login.status === 401 && Boolean(dbEvent) && api.ok && api.hasEventForEmail;
  if (!ok) process.exitCode = 1;

  console.log({
    ok,
    baseUrl,
    loginStatus: login.status,
    dbHasEvent: Boolean(dbEvent),
    dbSampleId: dbEvent?.id ?? null,
    api,
  });
}

main()
  .catch((e) => {
    console.error("ERR", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end().catch(() => null);
  });
