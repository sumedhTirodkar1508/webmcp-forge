import { describe, expect, it } from "vitest";

import { pickCanonicalSite } from "@/lib/services/site-service";

/**
 * Choosing the canonical site for an origin.
 *
 * Databases created before origin became the identity can hold more than one
 * row per origin. The decision must never be "the newest", because the newest
 * is precisely the accidental row a cleared cookie produced — while the older
 * one holds the public id already pasted into the live website.
 */

const at = (iso: string) => new Date(iso);

function site(id: string, createdAt: string, published = false) {
  return {
    id,
    createdAt: at(createdAt),
    publishedConfigVersionId: published ? `cfg-${id}` : null,
  };
}

describe("pickCanonicalSite", () => {
  it("returns null when there are no candidates", () => {
    expect(pickCanonicalSite([])).toBeNull();
  });

  it("returns the only candidate", () => {
    const only = site("a", "2026-09-02T08:00:00Z");
    expect(pickCanonicalSite([only])).toBe(only);
  });

  it("prefers the earliest row, not the newest", () => {
    const original = site("original", "2026-09-02T08:23:41Z");
    const cookieResetDuplicate = site("duplicate", "2026-09-03T01:13:57Z");

    expect(pickCanonicalSite([cookieResetDuplicate, original])).toBe(original);
  });

  it("still prefers the earliest row when a later one has configurations", () => {
    // Having generated a configuration says nothing about identity — anyone
    // can generate one. The oldest row holds the public id already installed.
    const original = site("wmf_P71", "2026-09-02T08:23:41Z");
    const duplicate = site("wmf_CM34", "2026-09-03T01:13:57Z", true);

    expect(pickCanonicalSite([duplicate, original])).toBe(original);
    expect(pickCanonicalSite([original, duplicate])).toBe(original);
  });

  it("is independent of input ordering", () => {
    const a = site("a", "2026-09-01T00:00:00Z");
    const b = site("b", "2026-09-02T00:00:00Z");
    const c = site("c", "2026-09-03T00:00:00Z");

    const expected = pickCanonicalSite([a, b, c]);
    for (const order of [[c, b, a], [b, a, c], [c, a, b]]) {
      expect(pickCanonicalSite(order)).toBe(expected);
    }
  });

  it("does not mutate the caller's array", () => {
    const a = site("a", "2026-09-03T00:00:00Z");
    const b = site("b", "2026-09-01T00:00:00Z");
    const input = [a, b];

    pickCanonicalSite(input);
    expect(input).toEqual([a, b]);
  });
});
