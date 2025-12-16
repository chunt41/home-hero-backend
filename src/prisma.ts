// src/prisma.ts
import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in the environment");
}

/**
 * DEV-ONLY SSL workaround (Fix B)
 * ⚠️ Remove when you move to proper CA trust
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Load Supabase CA (safe even if unused later)
const ca = fs.readFileSync(
  path.join(process.cwd(), "certs", "supabase-ca.crt"),
  "utf8"
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca,
    rejectUnauthorized: true,
  },
});

const adapter = new PrismaPg(pool);

/**
 * ✅ SINGLE Prisma instance for entire app
 */
export const prisma = new PrismaClient({
  adapter,
});
