import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Live tests belong to the browser session that started them.
 *
 * A site is shared by every visitor of its origin (the shared demo portfolio,
 * say), so two people can be working on "the same site" at once. A live test
 * connects one person's real browser tab to Forge, so it must not be reachable
 * from anyone else's builder: they must not be able to send it commands, see
 * that it exists, or end it.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("live test isolation between visitors of one site", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let svc: typeof import("@/lib/services/live-test-service");
  let readiness: typeof import("@/lib/services/readiness-service");
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("@/lib/services/live-test-service");
    readiness = await import("@/lib/services/readiness-service");
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
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

  /** One shared site with a published config, and two visitors of it. */
  async function sharedSite() {
    const alice = await newSession();
    const bob = await newSession();
    const origin = `https://isolation-${RUN}-${counter++}.example`;
    const site = await prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: alice.id,
        canonicalUrl: `${origin}/`,
        origin,
      },
    });
    const version = await prisma.configVersion.create({
      data: {
        siteId: site.id,
        version: 1,
        runtimeConfig: { schemaVersion: 1, siteId: site.publicId },
        publishedAt: new Date(),
      },
    });
    await prisma.site.update({
      where: { id: site.id },
      data: { publishedConfigVersionId: version.id, status: "PUBLISHED" },
    });
    return { site, alice, bob };
  }

  /** Marks the test a session started as connected, as the target tab would. */
  async function connect(token: string, siteId: string, origin: string) {
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    await svc.markReady(token, site.publicId, origin, {
      runtimeVersion: "1.0.0",
      availableTools: ["get_skills", "list_projects"],
    });
  }

  function tokenFrom(testUrl: string): string {
    return new URL(testUrl).searchParams.get("__wmf_live_test")!;
  }

  it("another visitor cannot see that a test is connected", async () => {
    const { site, alice, bob } = await sharedSite();
    const issued = await svc.startLiveTest(alice, site.id);
    await connect(tokenFrom(issued.testUrl), site.id, site.origin);

    const mine = await svc.getLiveTestState({ siteId: site.id, builderSessionId: alice.id });
    const theirs = await svc.getLiveTestState({ siteId: site.id, builderSessionId: bob.id });

    expect(mine.connected).toBe(true);
    expect(theirs.connected).toBe(false);
    expect(theirs.availableTools).toEqual([]);
  });

  it("another visitor cannot queue a command to the connected tab", async () => {
    const { site, alice, bob } = await sharedSite();
    const issued = await svc.startLiveTest(alice, site.id);
    await connect(tokenFrom(issued.testUrl), site.id, site.origin);

    const forBob = await svc.queueCommand(
      { siteId: site.id, builderSessionId: bob.id },
      "get_skills",
      {},
    );
    expect(forBob).toBeNull();
    expect(await prisma.liveTestCommand.count({ where: { session: { siteId: site.id } } })).toBe(0);

    // The owner still can.
    const forAlice = await svc.queueCommand(
      { siteId: site.id, builderSessionId: alice.id },
      "get_skills",
      {},
    );
    expect(forAlice).not.toBeNull();
  });

  it("another visitor cannot end someone else's test", async () => {
    const { site, alice, bob } = await sharedSite();
    const issued = await svc.startLiveTest(alice, site.id);
    await connect(tokenFrom(issued.testUrl), site.id, site.origin);

    await svc.closeLiveTest(bob, site.id);

    const state = await svc.getLiveTestState({ siteId: site.id, builderSessionId: alice.id });
    expect(state.connected).toBe(true);

    // The owner ending their own test still works.
    await svc.closeLiveTest(alice, site.id);
    const after = await svc.getLiveTestState({ siteId: site.id, builderSessionId: alice.id });
    expect(after.connected).toBe(false);
  });

  it("starting a test does not close another visitor's", async () => {
    const { site, alice, bob } = await sharedSite();
    const first = await svc.startLiveTest(alice, site.id);
    await connect(tokenFrom(first.testUrl), site.id, site.origin);

    // Bob opens his own test on the same site.
    await svc.startLiveTest(bob, site.id);

    const state = await svc.getLiveTestState({ siteId: site.id, builderSessionId: alice.id });
    expect(state.connected).toBe(true);
  });

  it("a visitor starting a second test still replaces their own first one", async () => {
    const { site, alice } = await sharedSite();
    const first = await svc.startLiveTest(alice, site.id);
    await svc.startLiveTest(alice, site.id);

    const old = await prisma.liveTestSession.findUnique({
      where: { tokenHash: hashToken(tokenFrom(first.testUrl)) },
      select: { status: true },
    });
    expect(old?.status).toBe("CLOSED");
  });

  it("the readiness snapshot only reports the asking visitor's own live test", async () => {
    const { site, alice, bob } = await sharedSite();
    const issued = await svc.startLiveTest(alice, site.id);
    await connect(tokenFrom(issued.testUrl), site.id, site.origin);

    const forAlice = await readiness.buildReadinessSnapshot(site, alice.id);
    const forBob = await readiness.buildReadinessSnapshot(site, bob.id);

    expect(forAlice.liveTest.connected).toBe(true);
    expect(forBob.liveTest.connected).toBe(false);
  });

  it("a test from before the column existed matches no session", async () => {
    const { site, alice } = await sharedSite();
    const token = generateToken();
    await prisma.liveTestSession.create({
      data: {
        siteId: site.id,
        // createdBySessionId left null, as on rows predating the migration.
        tokenHash: hashToken(token),
        expectedOrigin: site.origin,
        status: "READY",
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        availableTools: ["get_skills"],
      },
    });

    const state = await svc.getLiveTestState({ siteId: site.id, builderSessionId: alice.id });
    expect(state.connected).toBe(false);
  });
});
