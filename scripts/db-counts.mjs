// Prints the row count of every public table, read-only.
//
//   node scripts/db-counts.mjs
//
// Run it against the old database, switch DIRECT_URL, run it again, and the two
// listings should match. It prints host and counts only — never credentials.
import path from "node:path";
import { createRequire } from "node:module";

import { config as loadEnv } from "dotenv";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

loadEnv({ path: path.join(process.cwd(), ".env.local"), override: false });
loadEnv({ override: false });

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DIRECT_URL (or DATABASE_URL) in .env.local first.");
  process.exit(1);
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
try {
  await client.connect();
  // A guard, not a promise: this script has no reason to write anything.
  await client.query("set default_transaction_read_only = on");

  const host = url.match(/@([^/:?]+)/)?.[1] ?? "unknown host";
  const version = (await client.query("show server_version")).rows[0].server_version;
  console.log(`Connected to ${host} (PostgreSQL ${version})\n`);

  const tables = (
    await client.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    )
  ).rows.map((row) => row.table_name);

  if (tables.length === 0) console.log("No tables yet.");
  for (const table of tables) {
    const { n } = (await client.query(`select count(*)::int as n from public."${table}"`)).rows[0];
    console.log(`${String(n).padStart(6)}  ${table}`);
  }
} catch (error) {
  console.error("Failed:", error.code ?? "", String(error.message).replace(/postgres\.[a-z0-9]+/g, "postgres.<ref>"));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
