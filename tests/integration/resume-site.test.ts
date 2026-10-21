import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasTestDatabase, pointPrismaAtTestDatabase } from "../setup/env";

/**
 * Resuming where you left off.
 *
 * A site is permanent per origin, so the first browser to scan an origin is
 * its creator forever. The builder page used to restore "the newest site this
 * session created" — which is nothing at all for a second visitor working on an
 * existing origin (the shared demo portfolio, or an owner with a new cookie).
 * Their builder reloaded empty. The page now restores the remembered site id.
 */

const describeDb = hasTestDatabase() ? describe : describe.skip;
if (hasTestDatabase()) pointPrismaAtTestDatabase();

describeDb("resuming the builder", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let setTargetUrl: typeof import("@/lib/services/site-service").setTargetUrl;
  let getInitialBuilderState: typeof import("@/lib/services/builder-service").getInitialBuilderState;
  let generateToken: typeof import("@/lib/tokens").generateToken;
  let hashToken: typeof import("@/lib/tokens").hashToken;

  const sessionIds: string[] = [];
  const touchedOrigins = new Set<string>();
  const A = "https://example.com/";
  const B = "https://www.iana.org/";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ setTargetUrl } = await import("@/lib/services/site-service"));
    ({ getInitialBuilderState } = await import("@/lib/services/builder-service"));
    ({ generateToken, hashToken } = await import("@/lib/tokens"));
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

  async function target(session: Awaited<ReturnType<typeof newSession>>, url: string) {
    const result = await setTargetUrl(session, url);
    touchedOrigins.add(result.site.origin);
    return result.site;
  }

  it("restores a site this session did not create", async () => {
    const first = await newSession();
    const second = await newSession();
    const site = await target(first, A);
    await target(second, A);

    // Without a remembered id, the second visitor has created nothing.
    expect((await getInitialBuilderState(second, null)).siteId).toBeNull();
    // With it, they resume the site they were working on.
    expect((await getInitialBuilderState(second, site.id)).siteId).toBe(site.id);
  });

  it("prefers the remembered site over the newest one the session created", async () => {
    const session = await newSession();
    const a = await target(session, A);
    await target(session, B);

    expect((await getInitialBuilderState(session, a.id)).siteId).toBe(a.id);
  });

  it("falls back to the session's own newest site when the remembered one is gone", async () => {
    const session = await newSession();
    const b = await target(session, B);

    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await getInitialBuilderState(session, missing)).siteId).toBe(b.id);
  });
});
