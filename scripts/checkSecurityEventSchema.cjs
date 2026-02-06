require("dotenv/config");

const { PrismaClient } = require("@prisma/client");
const { Prisma } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const fs = require("fs");
const path = require("path");

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

async function findTableColumns() {
  const candidateTableNames = [
    "SecurityEvent",
    "securityevent",
    "security_event",
    "security_events",
  ];

  for (const tableName of candidateTableNames) {
    // If the table doesn't exist, this returns []
    const rows = await prisma.$queryRaw(
      Prisma.sql`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${tableName}
        order by ordinal_position
      `,
    );

    const columnNames = (rows || [])
      .map((r) => r && r.column_name)
      .filter(Boolean);

    if (columnNames.length > 0) {
      return { tableName, columnNames };
    }
  }

  return { tableName: null, columnNames: [] };
}

async function main() {
  const { tableName, columnNames } = await findTableColumns();

  const requiredDbColumns = [
    "id",
    "type",
    "userId",
    "actorRole",
    "email",
    "targetType",
    "targetId",
    "ip",
    "userAgent",
    "details",
    "createdAt",
  ];

  const missing = requiredDbColumns.filter((c) => !columnNames.includes(c));

  const row = await prisma.securityEvent.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      actionType: true,
      actorUserId: true,
      actorRole: true,
      targetType: true,
      targetId: true,
      createdAt: true,
    },
  });

  const ok = Boolean(tableName) && missing.length === 0;
  if (!ok) process.exitCode = 1;

  console.log({
    ok,
    tableFound: tableName,
    missingColumns: missing,
    hasRow: Boolean(row),
    sample: row,
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
