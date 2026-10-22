import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

/**
 * Application-runtime Prisma client.
 *
 * Uses the PostgreSQL driver adapter against DATABASE_URL (the pooled hosted-Postgres
 * connection). Migrations deliberately use a different, session-mode connection
 * — see `prisma.config.ts`.
 *
 * Next.js hot-reloads modules in development, which would otherwise open a new
 * connection pool on every edit, so the client is stashed on `globalThis`.
 */
function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: getEnv().DATABASE_URL,
    // Bound how long a request waits for a connection. Without it, an
    // unreachable database leaves the request hanging until the platform kills
    // it; with it, the person gets a clear "try again" in seconds. Long enough
    // for a serverless database to wake from idle.
    connectionTimeoutMillis: 15_000,
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  __wmfPrisma?: PrismaClient;
};

function getClient(): PrismaClient {
  if (!globalForPrisma.__wmfPrisma) globalForPrisma.__wmfPrisma = createClient();
  return globalForPrisma.__wmfPrisma;
}

/**
 * The client, created on first use rather than on import.
 *
 * `next build` imports every route module to collect its configuration. Creating
 * the client at import time validated DATABASE_URL then, so a build without
 * database secrets — CI, or a Vercel preview missing its variables — failed
 * outright instead of producing a deployment that reports the missing setting
 * when it is actually used. Methods are bound to the real client, so
 * `prisma.$transaction(...)` and model delegates behave exactly as before.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property, client) as unknown;
    return typeof value === "function" ? value.bind(client) : value;
  },
});
