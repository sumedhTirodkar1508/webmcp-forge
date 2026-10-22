import path from "node:path";

import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Local development keeps its secrets in `.env.local`, which the Prisma CLI does
 * not read on its own, so we load it here. `override: false` means a real
 * process environment variable (CI, Vercel) always wins over the local file.
 *
 * Migrations use DIRECT_URL — a session-mode connection — because the pooled
 * DATABASE_URL used at runtime cannot run DDL. DATABASE_URL is the fallback so
 * that environments which only expose one connection string still work.
 */
loadEnv({ path: path.join(process.cwd(), ".env.local"), override: false });
loadEnv({ override: false });

const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

/**
 * Only some commands talk to a database. `prisma generate` — run by every
 * build — does not, so a build must not need database secrets: a Vercel
 * preview missing its variables, CI, or a fork should still compile. This used
 * to throw for every command, which is what turned a missing preview variable
 * into a failed build.
 */
const DATABASE_COMMANDS = new Set(["migrate", "db", "studio", "introspect"]);
const needsDatabase = process.argv.some((arg) => DATABASE_COMMANDS.has(arg));

if (!migrationUrl && needsDatabase) {
  throw new Error(
    "Prisma CLI needs DIRECT_URL (preferred) or DATABASE_URL to be set. See .env.example.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(migrationUrl ? { datasource: { url: migrationUrl } } : {}),
});
