import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * The deployment-wide AI spend ceiling counts every model request, from every
 * visitor, over a rolling 24 hours.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("global AI budget", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let getAiBudget: typeof import("@/lib/ai/budget").getAiBudget;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ getAiBudget } = await import("@/lib/ai/budget"));
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

  async function newSite() {
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(session.id);
    const origin = `https://budget-${RUN}-${counter++}.example`;
    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${origin}/`,
        origin,
      },
    });
  }

  const event = (siteId: string, createdAt: Date, status: "SUCCESS" | "TIMEOUT" = "SUCCESS") => ({
    siteId,
    purpose: "NL_DEMO" as const,
    model: "test-model",
    status,
    createdAt,
  });

  // Other suites may leave rows behind, so these assert on the CHANGE in the
  // count rather than an absolute number.
  it("counts model requests from every site over the last 24 hours", async () => {
    const before = (await getAiBudget()).used;
    const a = await newSite();
    const b = await newSite();

    await prisma.aiUsageEvent.createMany({
      data: [
        event(a.id, new Date()),
        event(a.id, new Date()),
        event(b.id, new Date(Date.now() - 23 * 60 * 60 * 1000)),
      ],
    });

    expect((await getAiBudget()).used - before).toBe(3);
  });

  it("counts failed requests too, since they are still billed work", async () => {
    const before = (await getAiBudget()).used;
    const site = await newSite();
    await prisma.aiUsageEvent.createMany({
      data: [event(site.id, new Date(), "TIMEOUT"), event(site.id, new Date(), "SUCCESS")],
    });
    expect((await getAiBudget()).used - before).toBe(2);
  });

  it("ignores requests older than 24 hours", async () => {
    const before = (await getAiBudget()).used;
    const site = await newSite();
    await prisma.aiUsageEvent.createMany({
      data: [
        event(site.id, new Date(Date.now() - 25 * 60 * 60 * 1000)),
        event(site.id, new Date(Date.now() - 48 * 60 * 60 * 1000)),
      ],
    });
    expect((await getAiBudget()).used - before).toBe(0);
  });
});
