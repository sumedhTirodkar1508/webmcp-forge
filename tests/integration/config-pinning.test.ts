import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Configuration versions and the deployment boundary.
 *
 * This MVP has no accounts, so the thing that protects a live website is that
 * generating a configuration in Forge cannot activate it. A website runs
 * whichever version it pins in `data-wmf-config`; a stranger may append v3, and
 * the site keeps running the v2 it deployed.
 *
 * These tests pin that boundary down, including the exact User A / User B
 * scenario the architecture calls out.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("configuration pinning", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let setTargetUrl: typeof import("@/lib/services/site-service").setTargetUrl;
  let generateConfiguration: typeof import("@/lib/services/config-service").generateConfiguration;
  let getConfigVersion: typeof import("@/lib/services/config-service").getConfigVersion;
  let setCapabilityEnabled: typeof import("@/lib/services/config-service").setCapabilityEnabled;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;
  let asJson: typeof import("@/lib/json").asJson;

  const sessionIds: string[] = [];
  const touchedOrigins = new Set<string>();
  const ORIGIN_URL = "https://example.com/";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setTargetUrl } = await import("@/lib/services/site-service"));
    ({ generateConfiguration, getConfigVersion, setCapabilityEnabled } = await import(
      "@/lib/services/config-service"
    ));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    ({ asJson } = await import("@/lib/json"));
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

  /** A site with a usable scan, so configurations can be generated for it. */
  async function scannedSite(session: Awaited<ReturnType<typeof newSession>>) {
    const { site } = await setTargetUrl(session, ORIGIN_URL);
    touchedOrigins.add(site.origin);

    await prisma.scanRun.create({
      data: {
        siteId: site.id,
        status: "SUCCEEDED",
        pagesScanned: 1,
        finishedAt: new Date(),
        semantic: asJson({
          mapping: {
            version: 1,
            projects: {
              route: "/",
              itemSelector: ".project-card",
              fields: { title: { selector: "h3", source: "text" } },
              expectedCount: 4,
            },
          },
          available: ["projects"],
          settings: { list_projects: true },
        }),
      },
    });

    return site;
  }

  it("a scan does not create a configuration version", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    expect(await prisma.configVersion.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("toggling a capability does not create a configuration version", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    await setCapabilityEnabled(session, site.id, "list_projects", false);
    await setCapabilityEnabled(session, site.id, "list_projects", true);

    // Editing is not deploying. Versions used to accumulate on every click.
    expect(await prisma.configVersion.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("explicit generation appends monotonically increasing versions", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    const first = await generateConfiguration(session, site.id);
    const second = await generateConfiguration(session, site.id);

    expect(first.configVersion.version).toBe(1);
    expect(second.configVersion.version).toBe(2);
  });

  it("never mutates an existing version", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    const first = await generateConfiguration(session, site.id);
    const beforeJson = JSON.stringify(first.configVersion.runtimeConfig);

    await setCapabilityEnabled(session, site.id, "list_projects", false);
    await generateConfiguration(session, site.id);

    const reread = await prisma.configVersion.findUniqueOrThrow({
      where: { id: first.configVersion.id },
    });
    expect(JSON.stringify(reread.runtimeConfig)).toBe(beforeJson);
  });

  it("gives concurrent generations distinct versions", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    const results = await Promise.all([
      generateConfiguration(session, site.id),
      generateConfiguration(session, site.id),
      generateConfiguration(session, site.id),
    ]);

    const versions = results.map((r) => r.configVersion.version).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(3);
    expect(versions).toEqual([1, 2, 3]);
  });

  it("serves exactly the requested version and never substitutes another", async () => {
    const session = await newSession();
    const site = await scannedSite(session);

    await generateConfiguration(session, site.id);
    await generateConfiguration(session, site.id);

    const v1 = await getConfigVersion(site.publicId, 1);
    const v2 = await getConfigVersion(site.publicId, 2);

    expect(v1?.config.configVersion).toBe(1);
    expect(v2?.config.configVersion).toBe(2);
  });

  it("returns null for a version that does not exist, rather than the latest", async () => {
    const session = await newSession();
    const site = await scannedSite(session);
    await generateConfiguration(session, site.id);

    // A pinned version that was never generated must fail, not silently
    // resolve to something else.
    expect(await getConfigVersion(site.publicId, 7)).toBeNull();
  });

  /**
   * The User A / User B scenario.
   *
   * The point of the whole design: an anonymous stranger can generate a newer
   * configuration for a public website, and the website carries on running the
   * version it actually deployed.
   */
  it("User B generating a newer config cannot change what User A's site runs", async () => {
    const userA = await newSession();
    const site = await scannedSite(userA);

    // A generates v1 and v2, and deploys v2 in the snippet.
    await generateConfiguration(userA, site.id);
    const deployed = await generateConfiguration(userA, site.id);
    expect(deployed.configVersion.version).toBe(2);
    const DEPLOYED_VERSION = 2;

    // B scans the same public origin from a different browser.
    const userB = await newSession();
    const { site: siteForB } = await setTargetUrl(userB, ORIGIN_URL);

    // B receives the same permanent site id, not a new one.
    expect(siteForB.publicId).toBe(site.publicId);
    expect(siteForB.id).toBe(site.id);

    // B generates v3.
    const bVersion = await generateConfiguration(userB, site.id);
    expect(bVersion.configVersion.version).toBe(3);

    // The live site still pins v2, so v2 is what it loads.
    const live = await getConfigVersion(site.publicId, DEPLOYED_VERSION);
    expect(live?.config.configVersion).toBe(2);

    // A generates v4 later; the deployed pin is still v2.
    const aVersion = await generateConfiguration(userA, site.id);
    expect(aVersion.configVersion.version).toBe(4);
    expect((await getConfigVersion(site.publicId, DEPLOYED_VERSION))?.config.configVersion).toBe(2);

    // Only changing the snippet to 4 activates v4.
    expect((await getConfigVersion(site.publicId, 4))?.config.configVersion).toBe(4);
  });

  it("every generated version carries the site's own origin for runtime binding", async () => {
    const session = await newSession();
    const site = await scannedSite(session);
    await generateConfiguration(session, site.id);

    const config = await getConfigVersion(site.publicId, 1);
    // The runtime refuses to register when this does not match the page.
    expect(config?.config.origin).toBe(site.origin);
    expect(config?.config.siteId).toBe(site.publicId);
  });
});
