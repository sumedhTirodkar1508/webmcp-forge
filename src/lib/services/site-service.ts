import "server-only";

import type { BuilderSession, Site } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { urlRejectionError } from "@/lib/scanner/url-errors";
import { generatePublicSiteId } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { assertSafeUrl } from "@/lib/scanner/url-safety";

/**
 * Site identity.
 *
 * A website has exactly one Forge site, identified by its normalized ORIGIN:
 *
 *     https://example.com  ->  wmf_XXXX…      (permanent)
 *
 * `public_id` is pasted into the website and must never change, so nothing
 * about the visiting browser may influence it. Re-scanning, clearing cookies,
 * switching browser, or restarting Forge all resolve to the same row.
 *
 * There is deliberately NO ownership model in this MVP. Anyone may scan a
 * public site and generate a configuration — but generating one changes
 * nothing on the live website, because the website pins the exact version it
 * runs via `data-wmf-config`. Deployment access to the website is the real
 * authorization boundary; see `config-service.ts`.
 */

export interface SetTargetResult {
  site: Site;
  /** True when this call registered the origin for the first time. */
  created: boolean;
}

/**
 * Picks the canonical site for an origin.
 *
 * Databases created before origin became the identity can still hold more than
 * one row per origin. The choice must be deterministic and must never be "the
 * newest", because the newest is the accidental row an earlier bug created —
 * while the oldest holds the public id already installed in the live website.
 */
export function pickCanonicalSite<T extends { createdAt: Date }>(
  candidates: readonly T[],
): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
}

async function findSiteForOrigin(
  origin: string,
  tx: Pick<typeof prisma, "site"> = prisma,
): Promise<Site | null> {
  const candidates = await tx.site.findMany({
    where: { origin },
    orderBy: { createdAt: "asc" },
  });

  if (candidates.length > 1) {
    logger.warn("site.duplicate_origin", { origin, count: candidates.length });
  }
  return pickCanonicalSite(candidates);
}

/** Loads a site by its public id, or null. */
export async function findSiteByPublicId(publicId: string): Promise<Site | null> {
  return prisma.site.findUnique({ where: { publicId } });
}

/**
 * Resolves the site for a target URL, creating it only for a new origin.
 *
 * There is deliberately no `siteId` parameter: identity comes from the URL,
 * never from what the client claims to be looking at.
 */
export async function setTargetUrl(
  session: BuilderSession,
  rawUrl: string,
): Promise<SetTargetResult> {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new AppError("INVALID_URL", "Enter the address of your portfolio.");
  }
  if (rawUrl.length > 2000) {
    throw new AppError("INVALID_URL", "That address is too long.");
  }

  const safety = await assertSafeUrl(rawUrl.trim());
  if (!safety.ok || !safety.url) {
    throw urlRejectionError(safety.reason);
  }

  const canonicalUrl = safety.url.toString();
  const origin = safety.url.origin;

  const existing = await findSiteForOrigin(origin);
  if (existing) {
    // Same origin, possibly a different path. Same site, same public id, and
    // all of its history intact.
    const site =
      existing.canonicalUrl === canonicalUrl
        ? existing
        : await prisma.site.update({
            where: { id: existing.id },
            data: { canonicalUrl },
          });
    return { site, created: false };
  }

  return createSiteForOrigin(session, origin, canonicalUrl);
}

/**
 * Registers a brand-new origin.
 *
 * Serialised with a transaction-scoped advisory lock keyed on the origin, so
 * two visitors submitting the same new URL at the same moment cannot both mint
 * a public identity for it. The lock releases at commit, which keeps it safe
 * through a transaction-pooling connection.
 */
async function createSiteForOrigin(
  session: BuilderSession,
  origin: string,
  canonicalUrl: string,
): Promise<SetTargetResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${origin}))`;

      // Re-check inside the lock: another request may have just created it.
      const raced = await findSiteForOrigin(origin, tx);
      if (raced) return { site: raced, created: false };

      const site = await tx.site.create({
        data: {
          publicId: generatePublicSiteId(),
          // Attribution only. It does not identify or authorize the site.
          createdBySessionId: session.id,
          canonicalUrl,
          origin,
          status: "DRAFT",
        },
      });

      return { site, created: true };
    });
  } catch (error) {
    // Once UNIQUE(origin) is enforced, a race loser lands here instead.
    if (isUniqueViolation(error)) {
      const raced = await findSiteForOrigin(origin);
      if (raced) return { site: raced, created: false };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * The site this browser was last working on.
 *
 * Builder sessions still exist — they carry cookie continuity, scan rate
 * limiting and the AI question ledger — but they no longer own anything.
 */
export async function getCurrentSite(session: BuilderSession): Promise<Site | null> {
  return prisma.site.findFirst({
    where: { createdBySessionId: session.id },
    orderBy: { updatedAt: "desc" },
  });
}
