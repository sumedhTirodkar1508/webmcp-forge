import { describe, expect, it } from "vitest";

import { hasTestDatabase } from "./env";

/**
 * The guard that keeps `pnpm test` from writing to a real database.
 *
 * Row-mutating integration suites once activated on `DATABASE_URL`, which in
 * this project points at hosted Supabase — so an ordinary `pnpm test` would
 * INSERT and DELETE against the live application database. They now opt in
 * only via `TEST_DATABASE_URL`, which is expected to name an ephemeral local
 * PostgreSQL that can be freely mutated and discarded.
 */

describe("test database guard", () => {
  it("never activates on the application's own DATABASE_URL", () => {
    const original = process.env.TEST_DATABASE_URL;
    try {
      delete process.env.TEST_DATABASE_URL;
      // Even with a perfectly good application database configured, the
      // mutating suites must stay switched off.
      process.env.DATABASE_URL = "postgresql://user:pw@db.supabase.co:5432/postgres";
      expect(hasTestDatabase()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    }
  });

  it("activates only when an explicit test database is named", () => {
    const original = process.env.TEST_DATABASE_URL;
    try {
      process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55433/scratch";
      expect(hasTestDatabase()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    }
  });

  it("points Prisma at the test database, never the application one", async () => {
    const original = { test: process.env.TEST_DATABASE_URL, app: process.env.DATABASE_URL };
    try {
      const { pointPrismaAtTestDatabase } = await import("./env");
      process.env.TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:55433/scratch";
      process.env.DATABASE_URL = "postgresql://user:pw@db.supabase.co:5432/postgres";

      pointPrismaAtTestDatabase();

      expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
      expect(process.env.DATABASE_URL).not.toContain("supabase");
    } finally {
      if (original.test === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original.test;
      if (original.app === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original.app;
    }
  });
});

describe("natural-language quota configuration", () => {
  /**
   * One authoritative limit.
   *
   * `NATURAL_LANGUAGE_DEMO_LIMIT` is the documented name and is accepted as an
   * alias of the canonical `GEMINI_NL_DEMO_MAX_QUESTIONS`. Raising it locally
   * to 50 must raise the ceiling everywhere — the readiness snapshot and the
   * insights panel previously hardcoded 3 and would have disagreed.
   */
  it("reads the limit from the environment, defaulting to 3", async () => {
    const { getEnv, resetEnvCache } = await import("@/lib/env");
    const original = process.env.GEMINI_NL_DEMO_MAX_QUESTIONS;
    const originalAlias = process.env.NATURAL_LANGUAGE_DEMO_LIMIT;

    try {
      delete process.env.GEMINI_NL_DEMO_MAX_QUESTIONS;
      delete process.env.NATURAL_LANGUAGE_DEMO_LIMIT;
      resetEnvCache();
      expect(getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS).toBe(3);

      // The documented name still works.
      process.env.NATURAL_LANGUAGE_DEMO_LIMIT = "50";
      resetEnvCache();
      expect(getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS).toBe(50);
    } finally {
      if (original === undefined) delete process.env.GEMINI_NL_DEMO_MAX_QUESTIONS;
      else process.env.GEMINI_NL_DEMO_MAX_QUESTIONS = original;
      if (originalAlias === undefined) delete process.env.NATURAL_LANGUAGE_DEMO_LIMIT;
      else process.env.NATURAL_LANGUAGE_DEMO_LIMIT = originalAlias;
      resetEnvCache();
    }
  });

  it("has no second quota variable", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = [
      "src/lib/env.ts",
      "src/lib/services/agent-chat-service.ts",
      "src/lib/services/insights-service.ts",
      "src/lib/services/readiness-service.ts",
      "src/lib/services/builder-service.ts",
    ].map((f) => readFileSync(f, "utf8"));

    for (const source of sources) {
      expect(source).not.toContain("AGENT_QUESTION_LIMIT");
    }
    // No file may reintroduce a hardcoded ceiling.
    expect(sources.join("\n")).not.toContain("LIFETIME_QUESTIONS = 3");
  });
});
