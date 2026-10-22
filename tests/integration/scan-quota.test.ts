import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * The hourly scan limit.
 *
 * It is anti-abuse for an endpoint that spends real money and bandwidth with no
 * account behind it, so it has to actually hold:
 *
 *   - it counts the scans a session STARTS, whoever registered the site first
 *     (it used to count scans on sites the session had created, so scanning an
 *     origin someone else registered was never counted);
 *   - it holds under parallel requests, not just sequential ones;
 *   - one visitor's scans never use up another's allowance.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("scan quota", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let reserveScanRun: typeof import("@/lib/services/scan-service").reserveScanRun;
  let limit: number;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ reserveScanRun } = await import("@/lib/services/scan-service"));
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    limit = (await import("@/lib/env")).getEnv().SCAN_MAX_PER_SESSION_PER_HOUR;
  });

  afterEach(async () => {
    await prisma.site.deleteMany({ where: { createdBySessionId: { in: sessionIds } } });
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

  /** A site registered by `creator`, which anyone may scan. */
  async function siteBy(creator: { id: string }) {
    const origin = `https://quota-${RUN}-${counter++}.example`;
    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: creator.id,
        canonicalUrl: `${origin}/`,
        origin,
      },
    });
  }

  it("counts scans of a site that a different session registered first", async () => {
    const creator = await newSession();
    const visitor = await newSession();
    const site = await siteBy(creator);

    // The visitor never created this site. Their scans must still count.
    for (let i = 0; i < limit; i++) await reserveScanRun(visitor, site.id);

    await expect(reserveScanRun(visitor, site.id)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("records which session started each scan", async () => {
    const creator = await newSession();
    const visitor = await newSession();
    const site = await siteBy(creator);

    const run = await reserveScanRun(visitor, site.id);
    expect(run.sessionId).toBe(visitor.id);
    expect(run.status).toBe("RUNNING");
  });

  it("holds under parallel requests: exactly the limit succeed", async () => {
    const session = await newSession();
    const site = await siteBy(session);

    const attempts = limit + 8;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => reserveScanRun(session, site.id)),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "RATE_LIMITED",
    ).length;

    expect(ok).toBe(limit);
    expect(refused).toBe(attempts - limit);
    expect(await prisma.scanRun.count({ where: { sessionId: session.id } })).toBe(limit);
  });

  it("one visitor using their allowance does not use up another's", async () => {
    const alice = await newSession();
    const bob = await newSession();
    const site = await siteBy(alice);

    for (let i = 0; i < limit; i++) await reserveScanRun(alice, site.id);
    await expect(reserveScanRun(alice, site.id)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // Bob scanning the very same site is unaffected.
    await expect(reserveScanRun(bob, site.id)).resolves.toMatchObject({ sessionId: bob.id });
  });

  it("only counts the last hour", async () => {
    const session = await newSession();
    const site = await siteBy(session);

    // A full allowance of scans, all more than an hour old.
    await prisma.scanRun.createMany({
      data: Array.from({ length: limit }, () => ({
        siteId: site.id,
        sessionId: session.id,
        status: "SUCCEEDED" as const,
        startedAt: new Date(Date.now() - 61 * 60 * 1000),
      })),
    });

    await expect(reserveScanRun(session, site.id)).resolves.toMatchObject({
      sessionId: session.id,
    });
  });

  it("does not count scans from before the column existed", async () => {
    const session = await newSession();
    const site = await siteBy(session);

    // Rows with no session recorded belong to no one's allowance.
    await prisma.scanRun.createMany({
      data: Array.from({ length: limit }, () => ({
        siteId: site.id,
        sessionId: null,
        status: "SUCCEEDED" as const,
      })),
    });

    await expect(reserveScanRun(session, site.id)).resolves.toBeDefined();
  });
});
