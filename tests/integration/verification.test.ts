import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasDatabase } from "../setup/env";

/**
 * Verification challenge and public-configuration boundary tests.
 *
 * The claims being defended:
 *   - a challenge is single-use, so a captured report cannot be replayed;
 *   - an expired challenge is refused;
 *   - a report whose browser-asserted Origin does not match the site's origin
 *     is refused;
 *   - a report naming a different site is refused;
 *   - a draft configuration is unreachable through the public endpoint;
 *   - the public payload contains no private field.
 *
 * Against the real database, for the same reason as `ownership.test.ts`.
 */

const describeDb = hasDatabase() ? describe : describe.skip;

describeDb("verification and the public boundary", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let recordVerification: typeof import("@/lib/services/verification-service").recordVerification;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const ORIGIN = "https://portfolio.example";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ recordVerification } = await import("@/lib/services/verification-service"));
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  async function newSite() {
    const session = await prisma.builderSession.create({
      data: {
        tokenHash: hashToken(generateToken()),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    sessionIds.push(session.id);

    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${ORIGIN}/`,
        origin: ORIGIN,
      },
    });
  }

  async function issueChallenge(siteId: string, expiresInMs = 60_000) {
    const challenge = generateToken();
    await prisma.verificationChallenge.create({
      data: {
        siteId,
        challengeHash: hashToken(challenge),
        expectedOrigin: ORIGIN,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });
    return challenge;
  }

  const report = (publicId: string, challenge: string) => ({
    siteId: publicId,
    challenge,
    runtimeVersion: "1.0.0",
    configVersion: 1,
    path: "/",
    webmcpAvailable: true,
    webmcpReason: null,
    toolsRegistered: 3,
    toolNames: ["get_profile", "list_projects", "get_contact_info"],
    toolsVisibleToBrowser: ["get_profile", "list_projects", "get_contact_info"],
    toolRegistrationFailures: [],
    existingTools: [],
    conflictingTools: [],
    liveCounts: { projects: 8 },
    mappingHealth: { list_projects: true },
  });

  it("stores only the hash of a challenge", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    const rows = await prisma.verificationChallenge.findMany({ where: { siteId: site.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.challengeHash).toBe(hashToken(challenge));
    expect(rows[0]!.challengeHash).not.toBe(challenge);
  });

  it("accepts a valid first report and records the run", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    const run = await recordVerification(report(site.publicId, challenge), ORIGIN);
    expect(run.siteId).toBe(site.id);
    expect(run.webmcpAvailable).toBe(true);
    expect(run.toolsRegistered).toBe(3);
  });

  it("rejects a replay of the same challenge", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    await recordVerification(report(site.publicId, challenge), ORIGIN);

    await expect(recordVerification(report(site.publicId, challenge), ORIGIN)).rejects.toMatchObject(
      { code: "VERIFICATION_CONSUMED" },
    );
  });

  it("rejects concurrent replays — exactly one wins", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    const results = await Promise.allSettled([
      recordVerification(report(site.publicId, challenge), ORIGIN),
      recordVerification(report(site.publicId, challenge), ORIGIN),
      recordVerification(report(site.publicId, challenge), ORIGIN),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("rejects an expired challenge", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id, -1000);

    await expect(recordVerification(report(site.publicId, challenge), ORIGIN)).rejects.toMatchObject(
      { code: "VERIFICATION_EXPIRED" },
    );
  });

  it("rejects an unknown challenge", async () => {
    const site = await newSite();

    await expect(
      recordVerification(report(site.publicId, generateToken()), ORIGIN),
    ).rejects.toMatchObject({ code: "VERIFICATION_EXPIRED" });
  });

  it("rejects a report from the wrong origin", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    await expect(
      recordVerification(report(site.publicId, challenge), "https://attacker.example"),
    ).rejects.toMatchObject({ code: "VERIFICATION_ORIGIN_MISMATCH" });
  });

  it("rejects a report with no Origin header at all", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    await expect(recordVerification(report(site.publicId, challenge), null)).rejects.toMatchObject({
      code: "VERIFICATION_ORIGIN_MISMATCH",
    });
  });

  it("rejects a report naming a different site", async () => {
    const site = await newSite();
    const other = await newSite();
    const challenge = await issueChallenge(site.id);

    await expect(
      recordVerification(report(other.publicId, challenge), ORIGIN),
    ).rejects.toMatchObject({ code: "VERIFICATION_SITE_MISMATCH" });
  });

  it("leaves an unconsumed challenge alone when a report is rejected", async () => {
    const site = await newSite();
    const challenge = await issueChallenge(site.id);

    await expect(
      recordVerification(report(site.publicId, challenge), "https://attacker.example"),
    ).rejects.toBeTruthy();

    const row = await prisma.verificationChallenge.findUnique({
      where: { challengeHash: hashToken(challenge) },
    });
    // A failed attempt must not burn the challenge, or an attacker could deny
    // the owner their verification simply by firing junk at the endpoint.
    expect(row?.consumedAt).toBeNull();
  });
});

describeDb("public configuration boundary", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let getPublishedConfig: typeof import("@/lib/services/config-service").getPublishedConfig;
  let serializeRuntimeConfig: typeof import("@/lib/services/config-service").serializeRuntimeConfig;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;
  let asJson: typeof import("@/lib/json").asJson;

  const sessionIds: string[] = [];
  const ORIGIN = "https://published.example";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ getPublishedConfig, serializeRuntimeConfig } = await import(
      "@/lib/services/config-service"
    ));
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    ({ asJson } = await import("@/lib/json"));
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  async function siteWithVersions() {
    const session = await prisma.builderSession.create({
      data: {
        tokenHash: hashToken(generateToken()),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    sessionIds.push(session.id);

    const site = await prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${ORIGIN}/`,
        origin: ORIGIN,
      },
    });

    const build = (version: number, capabilities: "few" | "many") =>
      serializeRuntimeConfig({
        publicId: site.publicId,
        origin: ORIGIN,
        configVersion: version,
        mapping: {
          version: 1,
          projects: {
            route: "/",
            itemSelector: ".project-card",
            fields: { title: { selector: "h3", source: "text" } },
            expectedCount: capabilities === "many" ? 8 : 4,
          },
        },
        settings: { list_projects: true, get_project: capabilities === "many" },
        generatedAt: new Date(),
      });

    const v1 = await prisma.configVersion.create({
      data: { siteId: site.id, version: 1, runtimeConfig: asJson(build(1, "few")) },
    });
    // v2 exists but is never published — the draft.
    await prisma.configVersion.create({
      data: { siteId: site.id, version: 2, runtimeConfig: asJson(build(2, "many")) },
    });

    await prisma.site.update({
      where: { id: site.id },
      data: { publishedConfigVersionId: v1.id, status: "PUBLISHED" },
    });
    await prisma.configVersion.update({
      where: { id: v1.id },
      data: { publishedAt: new Date() },
    });

    return site;
  }

  it("serves only the published version, never a newer draft", async () => {
    const site = await siteWithVersions();

    const published = await getPublishedConfig(site.publicId);
    expect(published).not.toBeNull();
    expect(published!.config.configVersion).toBe(1);
    // v2 exists in the database and must not be reachable from here.
    expect(published!.config.enabledCapabilities).not.toContain("get_project");
  });

  it("returns null for a site with nothing published", async () => {
    const session = await prisma.builderSession.create({
      data: {
        tokenHash: hashToken(generateToken()),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    sessionIds.push(session.id);

    const site = await prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${ORIGIN}/x`,
        origin: ORIGIN,
      },
    });
    await prisma.configVersion.create({
      data: {
        siteId: site.id,
        version: 1,
        runtimeConfig: asJson({ schemaVersion: 1, siteId: site.publicId }),
      },
    });

    // A draft alone must not make a site publicly readable.
    expect(await getPublishedConfig(site.publicId)).toBeNull();
  });

  it("returns null for an unknown public id", async () => {
    expect(await getPublishedConfig("wmf_00000000000000000000000A")).toBeNull();
  });

  it("exposes no private field in the public payload", async () => {
    const site = await siteWithVersions();
    const published = await getPublishedConfig(site.publicId);
    const payload = published!.config as unknown as Record<string, unknown>;

    // Allow-list, not a deny-list: a new field has to be added here
    // deliberately, so nothing leaks by being forgotten.
    expect(Object.keys(payload).sort()).toEqual(
      [
        "configVersion",
        "enabledCapabilities",
        "generatedAt",
        "mapping",
        "origin",
        "schemaVersion",
        "siteId",
      ].sort(),
    );

    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      site.id,
      site.createdBySessionId,
      "tokenHash",
      "challenge",
      "DATABASE_URL",
      "postgres",
      "apiKey",
      "GEMINI",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
