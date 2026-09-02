import type { Prisma } from "@/generated/prisma/client";

/**
 * Prepares a value for a Prisma `Json` column.
 *
 * Prisma's `InputJsonValue` requires an index signature, which our precise
 * domain interfaces deliberately do not have. The round-trip is not just a cast:
 * it also drops `undefined` properties, which Prisma rejects outright, and
 * guarantees the value really is serialisable before it reaches the database.
 */
export function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Reads a `Json` column back as an unknown, ready for schema validation. */
export function fromJson(value: Prisma.JsonValue | null | undefined): unknown {
  return value ?? null;
}
