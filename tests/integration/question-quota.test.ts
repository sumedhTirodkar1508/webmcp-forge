import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * The per-site question limit: one rule for what counts, and a reservation so
 * questions sent together cannot all slip past the limit.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("question quota", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let quota: typeof import("@/lib/ai/question-quota");
  let getAiBudget: typeof import("@/lib/ai/budget").getAiBudget;
  let limit: number;
  let generatePublicSiteId: typeof import("@/lib/ids").generatePublicSiteId;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const RUN = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    quota = await import("@/lib/ai/question-quota");
    ({ getAiBudget } = await import("@/lib/ai/budget"));
    ({ generatePublicSiteId } = await import("@/lib/ids"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
    limit = (await import("@/lib/env")).getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS;
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
    const origin = `https://questions-${RUN}-${counter++}.example`;
    return prisma.site.create({
      data: {
        publicId: generatePublicSiteId(),
        createdBySessionId: session.id,
        canonicalUrl: `${origin}/`,
        origin,
      },
    });
  }

  type Row = { status: "SUCCESS" | "TIMEOUT" | "RESERVED"; errorCode?: string | null; createdAt?: Date };
  async function rows(siteId: string, list: Row[]) {
    await prisma.aiUsageEvent.createMany({
      data: list.map((row) => ({
        siteId,
        purpose: "NL_DEMO" as const,
        model: "test-model",
        status: row.status,
        errorCode: row.errorCode ?? null,
        createdAt: row.createdAt ?? new Date(),
      })),
    });
  }

  it("counts one question per successful routing row — not summaries, failures or holds", async () => {
    const site = await newSite();
    await rows(site.id, [
      { status: "SUCCESS" }, // question 1 (readiness answer)
      { status: "SUCCESS" }, // question 2 (live answer)…
      { status: "SUCCESS", errorCode: "summarize" }, // …whose summary is not another question
      { status: "TIMEOUT" }, // a failed attempt
      { status: "RESERVED" }, // a slot held right now
    ]);
    expect(await quota.countQuestionsUsed(site.id)).toBe(2);
    expect(await quota.questionsRemaining(site.id)).toBe(Math.max(0, limit - 2));
  });

  it("questions sent together cannot exceed the limit", async () => {
    const site = await newSite();
    const attempts = limit + 5;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => quota.reserveQuestion(site.id)),
    );
    const held = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "DEMO_LIMIT_REACHED",
    ).length;

    expect(held).toBe(limit);
    expect(refused).toBe(attempts - limit);
  });

  it("a released slot can be used again, and releasing twice is harmless", async () => {
    const site = await newSite();
    const reservations = [];
    for (let i = 0; i < limit; i++) reservations.push(await quota.reserveQuestion(site.id));
    await expect(quota.reserveQuestion(site.id)).rejects.toMatchObject({
      code: "DEMO_LIMIT_REACHED",
    });

    await reservations[0]!.release();
    await reservations[0]!.release();

    await expect(quota.reserveQuestion(site.id)).resolves.toBeDefined();
  });

  it("finished questions still use up the limit after their slot is released", async () => {
    const site = await newSite();
    await rows(site.id, Array.from({ length: limit }, () => ({ status: "SUCCESS" as const })));
    await expect(quota.reserveQuestion(site.id)).rejects.toMatchObject({
      code: "DEMO_LIMIT_REACHED",
    });
  });

  it("a slot left behind by a request that died stops counting after the TTL", async () => {
    const site = await newSite();
    const old = new Date(Date.now() - quota.RESERVATION_TTL_MS - 1000);
    await rows(site.id, Array.from({ length: limit }, () => ({ status: "RESERVED" as const, createdAt: old })));

    await expect(quota.reserveQuestion(site.id)).resolves.toBeDefined();
    // And the stale holds were cleared rather than accumulating.
    expect(
      await prisma.aiUsageEvent.count({
        where: { siteId: site.id, status: "RESERVED", createdAt: { lt: new Date(Date.now() - quota.RESERVATION_TTL_MS) } },
      }),
    ).toBe(0);
  });

  it("held slots are not counted as AI spend", async () => {
    const before = (await getAiBudget()).used;
    const site = await newSite();
    const held = await quota.reserveQuestion(site.id);
    expect((await getAiBudget()).used - before).toBe(0);
    await held.release();
  });
});
