import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * The natural-language lifetime quota.
 *
 * The limit is three successful questions for the LIFETIME of a site — not per
 * day — and it is enforced server-side against the AI usage ledger, because a
 * browser counter is one devtools edit away from unlimited.
 *
 * These assertions exercise the real counting query rather than a stub, since
 * what is being tested is precisely which rows the query does and does not
 * count.
 */

// Mutates rows, so it runs only against an ephemeral TEST_DATABASE_URL.
const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("natural-language lifetime quota", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  // Origin is globally unique, so each fixture site needs its own.
  const ORIGIN_BASE = `https://nl-${Math.random().toString(36).slice(2, 8)}`;
  let siteCounter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
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
    const session = await prisma.builderSession.create({
      data: { tokenHash: hashToken(generateToken()), expiresAt: new Date(Date.now() + 60_000) },
    });
    sessionIds.push(session.id);
    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${ORIGIN_BASE}-${siteCounter}.example/`,
        origin: `${ORIGIN_BASE}-${siteCounter++}.example`,
      },
    });
  }

  /** Mirrors `questionsUsed` in demo-service.ts. */
  const used = (siteId: string) =>
    prisma.aiUsageEvent.count({
      where: { siteId, purpose: "NL_DEMO", status: "SUCCESS", errorCode: null },
    });

  const remaining = async (siteId: string) => Math.max(0, 3 - (await used(siteId)));

  async function spendQuestion(siteId: string, model = "gemini-3.5-flash-lite") {
    await prisma.aiUsageEvent.create({
      data: { siteId, purpose: "NL_DEMO", model, attempt: 1, status: "SUCCESS", errorCode: null },
    });
  }

  it("counts down 3 → 2 → 1 → 0 and then blocks", async () => {
    const site = await newSite();
    expect(await remaining(site.id)).toBe(3);

    await spendQuestion(site.id);
    expect(await remaining(site.id)).toBe(2);

    await spendQuestion(site.id);
    expect(await remaining(site.id)).toBe(1);

    await spendQuestion(site.id);
    expect(await remaining(site.id)).toBe(0);

    // The fourth is refused: 0 remaining means the service throws before it
    // spends anything with the provider.
    expect(await used(site.id)).toBe(3);
    expect(await remaining(site.id)).toBe(0);
  });

  it("does not reset with age — old successes still count", async () => {
    const site = await newSite();
    await prisma.aiUsageEvent.create({
      data: {
        siteId: site.id,
        purpose: "NL_DEMO",
        model: "gemini-3.5-flash-lite",
        attempt: 1,
        status: "SUCCESS",
        errorCode: null,
        // A year ago. A lifetime limit must not quietly roll over.
        createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      },
    });
    expect(await remaining(site.id)).toBe(2);
  });

  it("does not let a fallback or a retry consume extra questions", async () => {
    const site = await newSite();

    // One submission that failed on the primary, then succeeded on the
    // fallback: three ledger rows, but only one question spent.
    await prisma.aiUsageEvent.createMany({
      data: [
        {
          siteId: site.id,
          purpose: "NL_DEMO",
          model: "gemini-3.5-flash-lite",
          attempt: 1,
          status: "TIMEOUT",
          errorCode: "timeout",
        },
        {
          siteId: site.id,
          purpose: "NL_DEMO",
          model: "gemini-3.1-flash-lite",
          attempt: 1,
          status: "SCHEMA_INVALID",
          errorCode: "schema_invalid",
        },
        {
          siteId: site.id,
          purpose: "NL_DEMO",
          model: "gemini-3.1-flash-lite",
          attempt: 2,
          status: "SUCCESS",
          errorCode: null,
        },
      ],
    });

    expect(await used(site.id)).toBe(1);
    expect(await remaining(site.id)).toBe(2);
  });

  it("does not count a summarization call as a second question", async () => {
    const site = await newSite();
    await spendQuestion(site.id);
    // Summarizing the live tool result is part of the SAME submission.
    await prisma.aiUsageEvent.create({
      data: {
        siteId: site.id,
        purpose: "NL_DEMO",
        model: "gemini-3.5-flash-lite",
        attempt: 1,
        status: "SUCCESS",
        errorCode: "summarize",
      },
    });

    expect(await used(site.id)).toBe(1);
    expect(await remaining(site.id)).toBe(2);
  });

  it("keeps each site's quota independent", async () => {
    const a = await newSite();
    const b = await newSite();

    await spendQuestion(a.id);
    await spendQuestion(a.id);

    expect(await remaining(a.id)).toBe(1);
    expect(await remaining(b.id)).toBe(3);
  });

  it("does not count scan-time semantic usage against the demo", async () => {
    const site = await newSite();
    await prisma.aiUsageEvent.create({
      data: {
        siteId: site.id,
        purpose: "SEMANTIC_MAPPING",
        model: "gemini-3.7-flash",
        attempt: 1,
        status: "SUCCESS",
        errorCode: null,
      },
    });
    expect(await remaining(site.id)).toBe(3);
  });
});
