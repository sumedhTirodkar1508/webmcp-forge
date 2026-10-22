import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * The live agent test relay.
 *
 * This channel lets a question typed in Forge cause a real
 * `document.modelContext.executeTool` call inside someone's portfolio, so its
 * security properties are asserted directly rather than inferred:
 *
 *   - a token alone is not enough; the browser-asserted Origin must match
 *   - an expired or closed session is refused
 *   - a command is handed out at most once, however often the target polls
 *   - a result is accepted at most once, however often it posts
 *   - only read-only tools are reachable by natural-language routing
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("live agent test relay", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let svc: typeof import("@/lib/services/live-test-service");
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  // Randomised per run so leftovers from an interrupted run cannot collide
  // with this one on the globally-unique origin.
  const RUN = Math.random().toString(36).slice(2, 8);
  const ORIGIN_BASE = `https://live-${RUN}`;
  let siteCounter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("@/lib/services/live-test-service");
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      // Sites deliberately outlive their creating session now, so they must
      // be removed explicitly or they collide on the unique origin.
      await prisma.site.deleteMany({ where: { createdBySessionId: { in: sessionIds } } });
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  async function newSite() {
    const builder = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(builder.id);
    // Origin is globally unique now, so each fixture site needs its own.
    const origin = `${ORIGIN_BASE}-${siteCounter++}.example`;
    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: builder.id,
        canonicalUrl: `${origin}/`,
        origin,
        // Authorization is an explicit grant, not implied by creation.
      },
    });
  }

  /** A site with a published config, which `startLiveTest` requires. */
  async function publishedSite() {
    const site = await newSite();
    const version = await prisma.configVersion.create({
      data: {
        siteId: site.id,
        version: 1,
        runtimeConfig: { schemaVersion: 1, siteId: site.publicId },
        publishedAt: new Date(),
      },
    });
    return prisma.site.update({
      where: { id: site.id },
      data: { publishedConfigVersionId: version.id, status: "PUBLISHED" },
    });
  }

  /**
   * Who is asking: the browser session that created the fixture site. Live
   * tests are scoped to the session that started them, so tests that queue
   * commands must be the same session as the one that opened the test.
   */
  function ownerOf(site: { id: string; createdBySessionId: string | null }) {
    return { siteId: site.id, builderSessionId: site.createdBySessionId! };
  }

  /** Opens a READY session directly, bypassing the builder-side ownership path. */
  async function readySession(siteId: string, ttlMs = 60_000, startedBy?: string) {
    const token = generateToken();
    const owner = await prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { origin: true, createdBySessionId: true },
    });
    await prisma.liveTestSession.create({
      data: {
        siteId,
        createdBySessionId: startedBy ?? owner.createdBySessionId,
        tokenHash: hashToken(token),
        expectedOrigin: owner.origin,
        status: "READY",
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + ttlMs),
        availableTools: ["get_skills", "list_projects"],
      },
    });
    return token;
  }

  it("allows read and view-changing tools, but never submission", () => {
    for (const tool of [
      "get_profile",
      "list_projects",
      "get_project",
      "search_projects",
      "get_skills",
      "get_experience",
      "get_education",
      "get_contact_info",
      // View-changing tools are dispatchable: they move the page the owner
      // deliberately connected, they do not contact anyone.
      "navigate_site",
      "focus_project",
      // Staging a draft submits nothing.
      "prepare_contact_message",
    ]) {
      expect(svc.isLiveTestTool(tool), tool).toBe(true);
    }

    // Submitting someone's form is not something prose can consent to.
    for (const tool of ["send_contact_message", "submit_contact_message", "eval"]) {
      expect(svc.isLiveTestTool(tool), tool).toBe(false);
    }
  });

  it("accepts a ready report from the expected origin", async () => {
    const site = await newSite();
    const token = generateToken();
    await prisma.liveTestSession.create({
      data: {
        siteId: site.id,
        createdBySessionId: site.createdBySessionId,
        tokenHash: hashToken(token),
        expectedOrigin: site.origin,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await svc.markReady(token, site.publicId, site.origin, {
      runtimeVersion: "1.0.0",
      availableTools: ["get_skills"],
    });
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const state = await svc.getLiveTestState(ownerOf(site));
    expect(state.connected).toBe(true);
    expect(state.availableTools).toContain("get_skills");
  });

  it("rejects a ready report from the wrong origin", async () => {
    const site = await newSite();
    const token = await readySession(site.id);

    await expect(
      svc.markReady(token, site.publicId, "https://attacker.example", {
        runtimeVersion: "1.0.0",
        availableTools: [],
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_ORIGIN_MISMATCH" });
  });

  it("rejects a request with no Origin header at all", async () => {
    const site = await newSite();
    const token = await readySession(site.id);

    await expect(svc.claimNextCommand(token, site.publicId, null)).rejects.toMatchObject({
      code: "VERIFICATION_ORIGIN_MISMATCH",
    });
  });

  it("rejects a token belonging to a different site", async () => {
    const site = await newSite();
    const other = await newSite();
    const token = await readySession(site.id);

    await expect(
      svc.claimNextCommand(token, other.publicId, site.origin),
    ).rejects.toMatchObject({ code: "VERIFICATION_SITE_MISMATCH" });
  });

  it("rejects an expired session and marks it expired", async () => {
    const site = await newSite();
    const token = await readySession(site.id, -1000);

    await expect(svc.claimNextCommand(token, site.publicId, site.origin)).rejects.toMatchObject({
      code: "VERIFICATION_EXPIRED",
    });

    const row = await prisma.liveTestSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { status: true },
    });
    expect(row?.status).toBe("EXPIRED");
  });

  it("rejects an unknown token", async () => {
    const site = await newSite();
    await expect(
      svc.claimNextCommand(generateToken(), site.publicId, site.origin),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hands a queued command to the target exactly once", async () => {
    const site = await newSite();
    const token = await readySession(site.id);

    const queued = await svc.queueCommand(ownerOf(site), "get_skills", {});
    expect(queued).not.toBeNull();

    const first = await svc.claimNextCommand(token, site.publicId, site.origin);
    expect(first?.tool).toBe("get_skills");
    expect(first?.commandId).toBe(queued!.commandId);

    // Repeated polling must not re-issue the same command.
    const second = await svc.claimNextCommand(token, site.publicId, site.origin);
    expect(second).toBeNull();
  });

  it("gives a command to only one of two concurrent polls", async () => {
    const site = await newSite();
    const token = await readySession(site.id);
    await svc.queueCommand(ownerOf(site), "list_projects", {});

    const results = await Promise.all([
      svc.claimNextCommand(token, site.publicId, site.origin),
      svc.claimNextCommand(token, site.publicId, site.origin),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("accepts a result once and ignores a duplicate post", async () => {
    const site = await newSite();
    const token = await readySession(site.id);
    const queued = await svc.queueCommand(ownerOf(site), "get_skills", {});
    await svc.claimNextCommand(token, site.publicId, site.origin);

    const first = await svc.completeCommand(token, site.publicId, site.origin, {
      commandId: queued!.commandId,
      result: "Cloud & DevOps: Kubernetes",
    });
    expect(first.accepted).toBe(true);

    const replay = await svc.completeCommand(token, site.publicId, site.origin, {
      commandId: queued!.commandId,
      result: "tampered",
    });
    expect(replay.accepted).toBe(false);

    const row = await svc.readCommand(queued!.commandId);
    // The first answer is the one that happened.
    expect(row?.result).toBe("Cloud & DevOps: Kubernetes");
    expect(row?.status).toBe("COMPLETED");
  });

  it("truncates an oversized result rather than storing it whole", async () => {
    const site = await newSite();
    const token = await readySession(site.id);
    const queued = await svc.queueCommand(ownerOf(site), "get_skills", {});
    await svc.claimNextCommand(token, site.publicId, site.origin);

    await svc.completeCommand(token, site.publicId, site.origin, {
      commandId: queued!.commandId,
      result: "x".repeat(svc.MAX_RESULT_CHARS + 5000),
    });

    const row = await svc.readCommand(queued!.commandId);
    expect(row?.result?.length).toBe(svc.MAX_RESULT_CHARS);
  });

  it("does not queue a command when no target is connected", async () => {
    const site = await newSite();
    expect(await svc.queueCommand(ownerOf(site), "get_skills", {})).toBeNull();
  });

  it("reports a failure result without treating it as a completion", async () => {
    const site = await newSite();
    const token = await readySession(site.id);
    const queued = await svc.queueCommand(ownerOf(site), "get_skills", {});
    await svc.claimNextCommand(token, site.publicId, site.origin);

    await svc.completeCommand(token, site.publicId, site.origin, {
      commandId: queued!.commandId,
      errorCode: "executeTool_unsupported",
    });

    const row = await svc.readCommand(queued!.commandId);
    expect(row?.status).toBe("FAILED");
    expect(row?.result).toBeNull();
  });

  it("times out honestly when the target never answers", async () => {
    const site = await newSite();
    await readySession(site.id);
    const queued = await svc.queueCommand(ownerOf(site), "get_skills", {});

    const outcome = await svc.awaitCommandResult(queued!.commandId, {
      timeoutMs: 30,
      intervalMs: 10,
      sleep: async () => {},
    });
    expect(outcome.status).toBe("timeout");
  });

  it("refuses to start a test before the snippet has been published", async () => {
    const site = await newSite();
    const builder = await prisma.builderSession.findUniqueOrThrow({
      where: { id: site.createdBySessionId ?? undefined },
    });

    // Without a published config there is nothing installed to talk to.
    await expect(svc.startLiveTest(builder, site.id)).rejects.toMatchObject({
      code: "NO_PUBLISHED_CONFIG",
    });
  });

  it("closes any previous session when a new test starts", async () => {
    const site = await publishedSite();
    const first = await readySession(site.id);

    const builder = await prisma.builderSession.findUniqueOrThrow({
      where: { id: site.createdBySessionId ?? undefined },
    });
    const issued = await svc.startLiveTest(builder, site.id);
    expect(issued.testUrl).toContain("__wmf_live_test=");

    const old = await prisma.liveTestSession.findUnique({
      where: { tokenHash: hashToken(first) },
      select: { status: true },
    });
    // A stale open channel is a liability, so starting a test closes the old one.
    expect(old?.status).toBe("CLOSED");
  });

  it("lets any session start a live test, since there is no ownership model", async () => {
    const site = await publishedSite();
    const other = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(other.id);

    // Safe because the target runs whatever version its own snippet pins.
    const issued = await svc.startLiveTest(other, site.id);
    expect(issued.testUrl).toContain("__wmf_live_test=");
  });
});
