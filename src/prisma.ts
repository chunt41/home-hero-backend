// src/prisma.ts
import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as fs from "fs";
import * as path from "path";

if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in the environment");
}


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
