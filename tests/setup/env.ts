import path from "node:path";

import { config as loadEnv } from "dotenv";

/**
 * Environment for the test run.
 *
 * `override: false` so a real process variable (CI) always wins over the local
 * file.
 */
loadEnv({ path: path.join(process.cwd(), ".env.local"), override: false });
loadEnv({ override: false });

/**
 * Whether the database-backed integration suites may run.
 *
 * They deliberately INSERT and DELETE rows, so they must never point at a
 * shared or production database. `DATABASE_URL` is the application's real
 * connection — often a hosted Supabase instance — and is therefore NOT
 * accepted here. The suites opt in only via `TEST_DATABASE_URL`, which is
 * expected to name a local or ephemeral PostgreSQL that can be freely
 * mutated and thrown away.
 *
 * With no `TEST_DATABASE_URL` set, those suites skip and `pnpm test` remains
 * completely read-only with respect to any configured database.
 */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}

/**
 * Points the Prisma client at the ephemeral test database.
 *
 * Must be called before `@/lib/prisma` is first imported, since the client
 * reads `DATABASE_URL` when it is constructed.
 */
export function pointPrismaAtTestDatabase(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  process.env.DATABASE_URL = url;
}
