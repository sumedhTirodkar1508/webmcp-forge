import { describe, expect, it } from "vitest";

import { isDatabaseUnavailable, summarizeDatabaseError, toAppError } from "@/lib/errors";

/**
 * An unreachable database is reported as "try again in a few seconds", not as
 * a generic failure — but a query that ran and failed must NOT be disguised as
 * an outage, or real bugs would hide behind a retry message.
 */

/** Shaped like a Prisma known-request error. */
function prismaError(code: string, message = "query failed"): Error {
  return Object.assign(new Error(message), { name: "PrismaClientKnownRequestError", code });
}

describe("isDatabaseUnavailable", () => {
  it("recognises the paused-database error seen in production logs", () => {
    const seen = new Error(
      "Invalid `prisma.builderSession.create()` invocation: Database error. Code: `XX000`. Message: `(ENOTFOUND) tenant/user postgres.abcdefghijkl not found`",
    );
    expect(isDatabaseUnavailable(seen)).toBe(true);
  });

  it("recognises Prisma's connectivity error codes", () => {
    for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024"]) {
      expect(isDatabaseUnavailable(prismaError(code)), code).toBe(true);
    }
  });

  it("recognises a client that could not initialise", () => {
    const error = Object.assign(new Error("boom"), { name: "PrismaClientInitializationError" });
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it("recognises network failures from the driver", () => {
    for (const message of [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "getaddrinfo ENOTFOUND db.example.com",
      "Connection terminated unexpectedly",
      "timeout exceeded when trying to connect",
      "sorry, too many clients already",
      "the database system is starting up",
    ]) {
      expect(isDatabaseUnavailable(new Error(message)), message).toBe(true);
    }
  });

  it("follows wrapped causes", () => {
    const inner = new Error("connect ETIMEDOUT 10.0.0.1:5432");
    const outer = new Error("query failed", { cause: inner });
    expect(isDatabaseUnavailable(outer)).toBe(true);
  });

  it("does not treat a query that ran and failed as an outage", () => {
    expect(isDatabaseUnavailable(prismaError("P2002", "Unique constraint failed"))).toBe(false);
    expect(isDatabaseUnavailable(prismaError("P2025", "Record to update not found"))).toBe(false);
    expect(isDatabaseUnavailable(new Error('column "nope" does not exist'))).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("cannot read properties of undefined"))).toBe(false);
  });

  it("ignores non-errors and does not loop on self-referencing causes", () => {
    expect(isDatabaseUnavailable(undefined)).toBe(false);
    expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
    const loop: { message: string; cause?: unknown } = { message: "x" };
    loop.cause = loop;
    expect(isDatabaseUnavailable(loop)).toBe(false);
  });
});

describe("toAppError", () => {
  it("maps an unreachable database to a 503 with a retry message", () => {
    const error = toAppError(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    expect(error.code).toBe("DATABASE_UNAVAILABLE");
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/try again in a few seconds/i);
    // The raw driver message never reaches the client.
    expect(error.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it("still maps everything else to a generic 500", () => {
    const error = toAppError(prismaError("P2002"));
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
  });
});

describe("summarizeDatabaseError", () => {
  it("keeps the cause, not Prisma's invocation preamble", () => {
    const error = Object.assign(
      new Error(
        "\nInvalid `prisma.builderSession.findUnique()` invocation in\n/app/.next/server/chunk.js:783\n\nconnect ECONNREFUSED 127.0.0.1:59999",
      ),
      { code: "P1001" },
    );
    expect(summarizeDatabaseError(error)).toBe("P1001: connect ECONNREFUSED 127.0.0.1:59999");
  });

  it("bounds the length", () => {
    expect(summarizeDatabaseError(new Error("x".repeat(1000))).length).toBe(300);
  });
});
