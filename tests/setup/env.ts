import path from "node:path";

import { config as loadEnv } from "dotenv";

/**
 * Loads `.env.local` for the integration suites.
 *
 * `override: false` so a real process variable (CI) always wins. Suites that
 * need a database call `hasDatabase()` and skip themselves when there is none,
 * which keeps `pnpm test` runnable — and meaningful — without secrets.
 */
loadEnv({ path: path.join(process.cwd(), ".env.local"), override: false });
loadEnv({ override: false });

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
