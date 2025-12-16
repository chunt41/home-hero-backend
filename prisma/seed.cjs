require("dotenv/config");

const fs = require("fs");
const path = require("path");

const tls = require("tls");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

const ca = fs.readFileSync(path.join(__dirname, "../certs/supabase-ca.crt"), "utf8");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca,
    rejectUnauthorized: true,
  },
});


const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // sanity check: if this fails, it's purely pg/TLS, not Prisma
  await pool.query("SELECT 1");

  await prisma.webhookEndpoint.create({
    data: {
      url: "d9478ee4-4f9a-473a-a057-cb5cd8027df2@emailhook.site",
      secret: "dev_secret_123",
      enabled: true,
      events: ["bid.placed"],
    },
  });

  console.log("✅ Webhook endpoint seeded");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
