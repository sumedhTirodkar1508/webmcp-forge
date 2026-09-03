import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Site identity.
 *
 * A website has exactly one Forge site, keyed on its normalized ORIGIN. The
 * `public_id` is pasted into that website, so nothing about the visiting
 * browser may influence it: re-scanning, clearing cookies, switching browser
 * or restarting Forge must all resolve to the same row.
 *
 * There is no ownership model. What protects a live site is that generating a
 * configuration cannot activate it — see `config-pinning.test.ts`.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("site identity", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let setTargetUrl: typeof import("@/lib/services/site-service").setTargetUrl;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const touchedOrigins = new Set<string>();

  // Public hosts that resolve, so the SSRF check passes without network games.
  const A = "https://example.com/";
  const A_PATH = "https://example.com/work";
  const A_NO_SLASH = "https://example.com";
  const B = "https://www.iana.org/";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setTargetUrl } = await import("@/lib/services/site-service"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
  });

  afterEach(async () => {
    if (touchedOrigins.size > 0) {
      await prisma.site.deleteMany({ where: { origin: { in: [...touchedOrigins] } } });
      touchedOrigins.clear();
    }
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  async function newSession() {
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(session.id);
    return session;
  }

  async function target(session: Awaited<ReturnType<typeof newSession>>, url: string) {
    const result = await setTargetUrl(session, url);
    touchedOrigins.add(result.site.origin);
    return result;
  }

  it("A: repeating the same URL returns the same site id", async () => {
    const session = await newSession();
    const first = await target(session, A);
    const again = await target(session, A);

    expect(again.site.id).toBe(first.site.id);
    expect(again.site.publicId).toBe(first.site.publicId);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
  });

  it("B: different paths on one origin are the same site", async () => {
    const session = await newSession();
    const root = await target(session, A);

    for (const variant of [A_PATH, A_NO_SLASH]) {
      const resolved = await target(session, variant);
      expect(resolved.site.publicId).toBe(root.site.publicId);
    }
    expect(await prisma.site.count({ where: { origin: new URL(A).origin } })).toBe(1);
  });

  it("C: replacing the builder session keeps the same site id", async () => {
    const original = await newSession();
    const before = await target(original, A);

    // Cookies cleared: the old session is gone entirely.
    await prisma.builderSession.delete({ where: { id: original.id } });

    const fresh = await newSession();
    const after = await target(fresh, A);

    // The snippet already installed in the real website keeps resolving.
    expect(after.site.publicId).toBe(before.site.publicId);
    expect(after.site.id).toBe(before.site.id);
    expect(after.created).toBe(false);
    expect(await prisma.site.count({ where: { origin: new URL(A).origin } })).toBe(1);
  });

  it("D: another anonymous session gets the same site id, with no error", async () => {
    const one = await newSession();
    const two = await newSession();

    const first = await target(one, A);
    const second = await target(two, A);

    expect(second.site.publicId).toBe(first.site.publicId);
    expect(second.created).toBe(false);
  });

  it("E: concurrent first-time requests create exactly one site", async () => {
    const sessions = await Promise.all([newSession(), newSession(), newSession()]);
    const results = await Promise.all(sessions.map((session) => target(session, B)));

    expect(new Set(results.map((r) => r.site.publicId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.site.count({ where: { origin: new URL(B).origin } })).toBe(1);
  });

  it("F: A -> B -> A restores the original ids", async () => {
    const session = await newSession();
    const first = await target(session, A);
    const other = await target(session, B);
    const back = await target(session, A);

    expect(back.site.publicId).toBe(first.site.publicId);
    expect(other.site.publicId).not.toBe(first.site.publicId);
    expect(back.created).toBe(false);
  });

  it("F2: switching back restores that site's persisted state", async () => {
    const session = await newSession();
    const first = await target(session, A);
    await prisma.site.update({
      where: { id: first.site.id },
      data: { status: "SCANNED", title: "Portfolio A", platform: "FRAMER" },
    });

    await target(session, B);
    const back = await target(session, A);

    expect(back.site.status).toBe("SCANNED");
    expect(back.site.title).toBe("Portfolio A");
    expect(back.site.platform).toBe("FRAMER");
  });

  it("different origins keep different site ids", async () => {
    const session = await newSession();
    const siteA = await target(session, A);
    const siteB = await target(session, B);

    expect(siteB.site.publicId).not.toBe(siteA.site.publicId);
    expect(siteB.site.id).not.toBe(siteA.site.id);
  });

  it("enforces one site per origin at the database level", async () => {
    const session = await newSession();
    const site = await target(session, A);
    const { generatePublicSiteId } = await import("@/lib/ids");

    await expect(
      prisma.site.create({
        data: {
          publicId: generatePublicSiteId(),
          createdBySessionId: session.id,
          canonicalUrl: A,
          origin: site.site.origin,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
