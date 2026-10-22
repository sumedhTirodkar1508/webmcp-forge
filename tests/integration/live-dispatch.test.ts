import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Which tools a typed request may actually run in a connected browser.
 *
 * Live Agent Test existed but only ever dispatched read tools, because the
 * allow-list contained nothing else — so "navigate to Work" or "draft a
 * message" fell through to explanatory text and nothing happened in the page.
 *
 * The corrected rule has three tiers:
 *   - read tools and the two view-changing tools may dispatch;
 *   - prepare_contact_message may dispatch, because it only stages a draft;
 *   - send_contact_message may NEVER be auto-dispatched, because submitting
 *     someone's form is not something prose can consent to.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("live tool dispatch", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let svc: typeof import("@/lib/services/live-test-service");
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;
  let asJson: typeof import("@/lib/json").asJson;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  // What the demo's config v2 registers: everything except get_education.
  const ADVERTISED = [
    "get_profile",
    "list_projects",
    "get_project",
    "search_projects",
    "get_skills",
    "get_experience",
    "get_contact_info",
    "navigate_site",
    "focus_project",
    "prepare_contact_message",
    "send_contact_message",
  ];

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("@/lib/services/live-test-service");
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    ({ asJson } = await import("@/lib/json"));
  });

  afterEach(async () => {
    await prisma.site.deleteMany({ where: { createdBySessionId: { in: sessionIds } } });
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await prisma.builderSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
  });

  /** A site with a READY live session advertising the demo's tool set. */
  async function connectedSite(advertised: string[] = ADVERTISED) {
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(session.id);

    const origin = `https://dispatch-${RUN}-${counter++}.example`;
    const site = await prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${origin}/`,
        origin,
      },
    });

    const token = generateToken();
    await prisma.liveTestSession.create({
      data: {
        siteId: site.id,
        // Started by the same session that is now asking questions.
        createdBySessionId: session.id,
        tokenHash: hashToken(token),
        expectedOrigin: origin,
        status: "READY",
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        availableTools: asJson(advertised),
      },
    });

    return { site, token, owner: { siteId: site.id, builderSessionId: session.id } };
  }

  it("read tools still dispatch", async () => {
    const { owner } = await connectedSite();

    for (const tool of ["list_projects", "search_projects", "get_skills"] as const) {
      const queued = await svc.queueCommand(owner, tool, {});
      expect(queued, tool).not.toBeNull();
      const row = await svc.readCommand(queued!.commandId);
      expect(row?.tool).toBe(tool);
      expect(row?.status).toBe("PENDING");
    }
  });

  it("navigate_site dispatches a real command", async () => {
    const { owner } = await connectedSite();

    const queued = await svc.queueCommand(owner, "navigate_site", { destination: "Work" });

    expect(queued).not.toBeNull();
    const row = await svc.readCommand(queued!.commandId);
    expect(row?.tool).toBe("navigate_site");
    expect(row?.arguments).toMatchObject({ destination: "Work" });
  });

  it("focus_project dispatches a real command", async () => {
    const { owner } = await connectedSite();

    const queued = await svc.queueCommand(owner, "focus_project", { title: "Fieldnote" });

    expect(queued).not.toBeNull();
    const row = await svc.readCommand(queued!.commandId);
    expect(row?.tool).toBe("focus_project");
    expect(row?.arguments).toMatchObject({ title: "Fieldnote" });
  });

  it("prepare_contact_message dispatches but stages only", async () => {
    const { site, owner } = await connectedSite();

    const queued = await svc.queueCommand(owner, "prepare_contact_message", {
      message: "Hello from WebMCP Forge.",
    });

    expect(queued).not.toBeNull();
    const row = await svc.readCommand(queued!.commandId);
    expect(row?.tool).toBe("prepare_contact_message");
    // Staging only: the handler returns a confirmationId and submits nothing.
    // Nothing here queues a send.
    const sends = await prisma.liveTestCommand.count({
      where: { session: { siteId: site.id }, tool: "send_contact_message" },
    });
    expect(sends).toBe(0);
  });

  it("send_contact_message can never be auto-dispatched", async () => {
    const { site, owner } = await connectedSite();

    // Even though the browser advertises it, prose may not trigger it.
    expect(svc.isLiveTestTool("send_contact_message")).toBe(false);
    expect(svc.isConsequentialTool("send_contact_message")).toBe(true);

    await expect(
      svc.queueCommand(owner, "send_contact_message" as never, { confirmed: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(
      await prisma.liveTestCommand.count({ where: { session: { siteId: site.id } } }),
    ).toBe(0);
  });

  it("a tool the target did not register is never dispatched", async () => {
    // get_education is disabled in the demo's config v2, so the browser never
    // registered it.
    const { site, owner } = await connectedSite();

    expect(await svc.queueCommand(owner, "get_education", {})).toBeNull();
    expect(
      await prisma.liveTestCommand.count({ where: { session: { siteId: site.id } } }),
    ).toBe(0);
  });

  it("dispatches nothing at all when no target is connected", async () => {
    const { site, owner } = await connectedSite();
    await prisma.liveTestSession.updateMany({
      where: { siteId: site.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    expect(await svc.queueCommand(owner, "navigate_site", { path: "/work" })).toBeNull();
  });
});

describe("dispatch policy", () => {
  it("allows read and view-changing tools, and blocks submission", async () => {
    const svc = await import("@/lib/services/live-test-service");

    for (const tool of [
      "get_profile",
      "list_projects",
      "get_project",
      "search_projects",
      "get_skills",
      "get_experience",
      "get_education",
      "get_contact_info",
      "navigate_site",
      "focus_project",
      "prepare_contact_message",
    ]) {
      expect(svc.isLiveTestTool(tool), tool).toBe(true);
    }

    for (const tool of ["send_contact_message", "submit_contact_message", "eval"]) {
      expect(svc.isLiveTestTool(tool), tool).toBe(false);
    }
  });
});
