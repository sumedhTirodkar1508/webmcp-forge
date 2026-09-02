import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

/**
 * Application-runtime Prisma client.
 *
 * Uses the PostgreSQL driver adapter against DATABASE_URL (the pooled Supabase
 * connection). Migrations deliberately use a different, session-mode connection
 * — see `prisma.config.ts`.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit, so the client is stashed on `globalThis`.
 */
function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  __wmfPrisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__wmfPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__wmfPrisma = prisma;
}
