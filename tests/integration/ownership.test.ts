import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasDatabase } from "../setup/env";

/**
 * Ownership and public/private boundary tests.
 *
 * These run against the real development database, because the thing being
 * tested is exactly the behaviour a mock would have to fake: that a query
 * scoped to one session cannot reach another session's row, and that a draft
 * configuration is unreachable from the public path. A stubbed Prisma would
 * only prove the stub agrees with itself.
 *
 * They skip cleanly when no DATABASE_URL is configured, so `pnpm test` still
 * works in a checkout without secrets.
 */

const describeDb = hasDatabase() ? describe : describe.skip;

describeDb("anonymous ownership", () => {
  // Imported lazily so the module (and its env parsing) is only touched when
  // the suite actually runs.
  let prisma: typeof import("@/lib/prisma").prisma;
  let requireOwnedSiteFor: typeof import("@/lib/session").requireOwnedSiteFor;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ requireOwnedSiteFor } = await import("@/lib/session"));
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      // Sites, configs and challenges all cascade from the session.
      await prisma.builderSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }
  });

  const newSession = async () => {
    const session = await prisma.builderSession.create({
      data: {
        tokenHash: hashToken(generateToken()),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    createdSessionIds.push(session.id);
    return session;
  };

  const newSite = async (sessionId: string) =>
    prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: sessionId,
        canonicalUrl: "https://example.com",
        origin: "https://example.com",
      },
    });

  it("stores only a hash of the session token, never the token", async () => {
    const token = generateToken();
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) },
    });
    createdSessionIds.push(session.id);

    const stored = await prisma.builderSession.findUnique({ where: { id: session.id } });
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.tokenHash).not.toBe(token);
    // A 256-bit token digested with SHA-256 is 64 hex characters.
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lets the owning session load its own site", async () => {
    const session = await newSession();
    const site = await newSite(session.id);

    const loaded = await requireOwnedSiteFor(session, site.id);
    expect(loaded.id).toBe(site.id);
  });

  it("refuses a site belonging to a different session", async () => {
    const owner = await newSession();
    const stranger = await newSession();
    const site = await newSite(owner.id);

    await expect(requireOwnedSiteFor(stranger, site.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reports a missing site the same way as a forbidden one", async () => {
    const stranger = await newSession();
    const owner = await newSession();
    const site = await newSite(owner.id);

    const forbidden = await requireOwnedSiteFor(stranger, site.id).catch((e: unknown) => e);
    const missing = await requireOwnedSiteFor(
      stranger,
      "00000000-0000-4000-8000-000000000000",
    ).catch((e: unknown) => e);

    // Identical responses, so a stranger cannot probe which site ids exist.
    expect((forbidden as { code: string }).code).toBe((missing as { code: string }).code);
    expect((forbidden as { message: string }).message).toBe(
      (missing as { message: string }).message,
    );
  });

  it("generates public site ids that are random, not sequential", async () => {
    const ids = new Set(Array.from({ length: 200 }, () => generatePublicSiteId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^wmf_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/);
  });
});
