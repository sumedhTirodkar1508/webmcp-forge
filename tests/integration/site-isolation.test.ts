import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Cross-site isolation.
 *
 * When two origins shared one site row they also shared a public id, and
 * therefore shared published configuration, verification challenges, live-test
 * sessions and AI quota. Now that identity is per-origin, these assertions pin
 * the boundaries so nothing can quietly reconnect them.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("cross-site isolation", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let recordVerification: typeof import("@/lib/services/verification-service").recordVerification;
  let getConfigVersion: typeof import("@/lib/services/config-service").getConfigVersion;
  let live: typeof import("@/lib/services/live-test-service");
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;
  let asJson: typeof import("@/lib/json").asJson;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let siteCounter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ recordVerification } = await import("@/lib/services/verification-service"));
    ({ getConfigVersion } = await import("@/lib/services/config-service"));
    live = await import("@/lib/services/live-test-service");
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    ({ asJson } = await import("@/lib/json"));
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      // Sites deliberately outlive their creating session now, so they must
      // be removed explicitly or they collide on the unique origin.
      await prisma.site.deleteMany({ where: { createdBySessionId: { in: sessionIds } } });
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  /**
   * Two sites owned by one session, created directly.
   *
   * Origins are globally unique now, so each invocation needs its own pair;
   * and creating the rows directly keeps these isolation assertions from
   * depending on DNS resolution inside `setTargetUrl`.
   */
  async function sessionWithBothSites() {
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(session.id);

    const make = async (label: string) => {
      const origin = `https://${label}-${RUN}-${siteCounter++}.example`;
      return prisma.site.create({
        data: {
          publicId: generatePublicSiteId(),
          createdBySessionId: session.id,
          canonicalUrl: `${origin}/`,
          origin,
        },
      });
    };

    return { session, siteA: await make("iso-a"), siteB: await make("iso-b") };
  }

  /**
   * Publishes a genuinely valid runtime config.
   *
   * `getConfigVersion` validates what it reads back and fails closed, and
   * the schema strips anything it does not declare — so a site is distinguished
   * here by real fields (`siteId`, `origin`) rather than a marker, which the
   * allow-list would correctly discard.
   */
  async function publish(siteId: string, publicId: string, origin: string, version_: number) {
    const version = await prisma.configVersion.create({
      data: {
        siteId,
        version: version_,
        runtimeConfig: asJson({
          schemaVersion: 1,
          siteId: publicId,
          configVersion: version_,
          origin,
          enabledCapabilities: [],
          mapping: { version: 1 },
          generatedAt: new Date().toISOString(),
        }),
        publishedAt: new Date(),
      },
    });
    await prisma.site.update({
      where: { id: siteId },
      data: { publishedConfigVersionId: version.id, status: "PUBLISHED" },
    });
  }

  it("F: a published config for A is never returned for B", async () => {
    const { siteA, siteB } = await sessionWithBothSites();
    await publish(siteA.id, siteA.publicId, siteA.origin, 1);
    await publish(siteB.id, siteB.publicId, siteB.origin, 2);

    const configA = await getConfigVersion(siteA.publicId, 1);
    const configB = await getConfigVersion(siteB.publicId, 2);

    expect(configA?.config.siteId).toBe(siteA.publicId);
    expect(configB?.config.siteId).toBe(siteB.publicId);
    expect(configA?.config.origin).toBe(siteA.origin);
    expect(configB?.config.origin).toBe(siteB.origin);
    expect(configA?.config.siteId).not.toBe(configB?.config.siteId);
    // Each origin's runtime therefore loads its own configuration, which is
    // exactly what a shared public id used to break.
    expect(configA?.config.configVersion).not.toBe(configB?.config.configVersion);
  });

  it("F2: a malformed published row fails closed rather than being served", async () => {
    const { siteA } = await sessionWithBothSites();
    const version = await prisma.configVersion.create({
      data: {
        siteId: siteA.id,
        version: 9,
        runtimeConfig: asJson({ schemaVersion: 1, siteId: siteA.publicId }),
        publishedAt: new Date(),
      },
    });
    await prisma.site.update({
      where: { id: siteA.id },
      data: { publishedConfigVersionId: version.id },
    });

    expect(await getConfigVersion(siteA.publicId, 9)).toBeNull();
  });

  it("G: a verification challenge for A cannot validate B", async () => {
    const { siteA, siteB } = await sessionWithBothSites();

    const challenge = generateToken();
    await prisma.verificationChallenge.create({
      data: {
        siteId: siteA.id,
        challengeHash: hashToken(challenge),
        expectedOrigin: siteA.origin,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const report = {
      // A's challenge, but claiming to be site B.
      siteId: siteB.publicId,
      challenge,
      runtimeVersion: "1.0.0",
      configVersion: 1,
      // The version the snippet pinned.
      pinnedVersion: 1,
      path: "/",
      webmcpAvailable: true,
      webmcpReason: null,
      toolsRegistered: 3,
      toolNames: [],
      toolsVisibleToBrowser: [],
      toolRegistrationFailures: [],
      existingTools: [],
      conflictingTools: [],
      liveCounts: {},
      mappingHealth: {},
    };

    await expect(recordVerification(report, siteA.origin)).rejects.toMatchObject({
      code: "VERIFICATION_SITE_MISMATCH",
    });
  });

  it("G2: A's challenge is refused when reported from B's origin", async () => {
    const { siteA, siteB } = await sessionWithBothSites();

    const challenge = generateToken();
    await prisma.verificationChallenge.create({
      data: {
        siteId: siteA.id,
        challengeHash: hashToken(challenge),
        expectedOrigin: siteA.origin,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      recordVerification(
        {
          siteId: siteA.publicId,
          challenge,
          runtimeVersion: "1.0.0",
          configVersion: 1,
          // The version the snippet pinned.
          pinnedVersion: 1,
          path: "/",
          webmcpAvailable: true,
          webmcpReason: null,
          toolsRegistered: 0,
          toolNames: [],
          toolsVisibleToBrowser: [],
          toolRegistrationFailures: [],
          existingTools: [],
          conflictingTools: [],
          liveCounts: {},
          mappingHealth: {},
        },
        siteB.origin,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_ORIGIN_MISMATCH" });
  });

  it("switching target mid-verification cannot reinterpret A's challenge as B", async () => {
    const { siteA } = await sessionWithBothSites();

    const challenge = generateToken();
    await prisma.verificationChallenge.create({
      data: {
        siteId: siteA.id,
        challengeHash: hashToken(challenge),
        expectedOrigin: siteA.origin,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const reloadedA = await prisma.site.findUniqueOrThrow({ where: { id: siteA.id } });
    // Origin is immutable, so an in-flight challenge still describes site A no
    // matter where the builder is pointed now.
    expect(reloadedA.origin).toBe(siteA.origin);

    const run = await recordVerification(
      {
        siteId: siteA.publicId,
        challenge,
        runtimeVersion: "1.0.0",
        configVersion: 1,
        // The version the snippet pinned.
        pinnedVersion: 1,
        path: "/",
        webmcpAvailable: true,
        webmcpReason: null,
        toolsRegistered: 3,
        toolNames: ["get_skills"],
        toolsVisibleToBrowser: ["get_skills"],
        toolRegistrationFailures: [],
        existingTools: [],
        conflictingTools: [],
        liveCounts: { projects: 4 },
        mappingHealth: { get_skills: true },
      },
      siteA.origin,
    );

    expect(run.siteId).toBe(siteA.id);
  });

  it("H: a live-test session for A cannot attach to B", async () => {
    const { siteA, siteB } = await sessionWithBothSites();

    const token = generateToken();
    await prisma.liveTestSession.create({
      data: {
        siteId: siteA.id,
        tokenHash: hashToken(token),
        expectedOrigin: siteA.origin,
        status: "READY",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(
      live.claimNextCommand(token, siteB.publicId, siteA.origin),
    ).rejects.toMatchObject({ code: "VERIFICATION_SITE_MISMATCH" });
  });

  it("keeps AI quota independent per site", async () => {
    const { siteA, siteB } = await sessionWithBothSites();

    const spend = (siteId: string) =>
      prisma.aiUsageEvent.create({
        data: {
          siteId,
          purpose: "NL_DEMO",
          model: "gemini-3.5-flash-lite",
          attempt: 1,
          status: "SUCCESS",
          errorCode: null,
        },
      });

    await spend(siteA.id);
    await spend(siteA.id);
    await spend(siteA.id);

    const used = (siteId: string) =>
      prisma.aiUsageEvent.count({
        where: { siteId, purpose: "NL_DEMO", status: "SUCCESS", errorCode: null },
      });

    expect(await used(siteA.id)).toBe(3);
    // Exhausting the production portfolio must not exhaust the demo.
    expect(await used(siteB.id)).toBe(0);
  });

  it("keeps insights scoped to one site", async () => {
    const { siteA, siteB } = await sessionWithBothSites();
    const { buildInsights } = await import("@/lib/services/insights-service");

    await prisma.scanRun.create({
      data: { siteId: siteA.id, status: "SUCCEEDED", pagesScanned: 7 },
    });

    const insightsA = await buildInsights(siteA);
    const insightsB = await buildInsights(siteB);

    expect(insightsA.scans.total).toBe(1);
    expect(insightsA.scans.pagesScanned).toBe(7);
    expect(insightsB.scans.total).toBe(0);
    expect(insightsB.scans.pagesScanned).toBe(0);
  });
});
