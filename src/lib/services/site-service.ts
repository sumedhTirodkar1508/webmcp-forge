import "server-only";

import type { BuilderSession, Site } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { generatePublicSiteId } from "@/lib/ids";
import { prisma } from "@/lib/prisma";
import { assertSafeUrl } from "@/lib/scanner/url-safety";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * Creating and re-targeting a site.
 *
 * The URL is validated here — scheme, credentials, port, and a real DNS
 * resolution against the private-range deny-list — before anything is written.
 * That means a blocked address never even creates a row, and the user gets the
 * refusal immediately rather than after a scan appears to start.
 */

export interface SetTargetResult {
  site: Site;
  /** True when this call created a new site rather than re-targeting one. */
  created: boolean;
}

export async function setTargetUrl(
  session: BuilderSession,
  rawUrl: string,
  siteId?: string,
): Promise<SetTargetResult> {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new AppError("INVALID_URL", "Enter the address of your portfolio.");
  }
  if (rawUrl.length > 2000) {
    throw new AppError("INVALID_URL", "That address is too long.");
  }

  const safety = await assertSafeUrl(rawUrl.trim());
  if (!safety.ok || !safety.url) {
    throw new AppError(
      safety.reason === "invalid_url" ? "INVALID_URL" : "BLOCKED_TARGET",
      safety.message ?? "That address cannot be scanned.",
    );
  }

  const canonicalUrl = safety.url.toString();
  const origin = safety.url.origin;

  if (siteId) {
    const existing = await requireOwnedSiteFor(session, siteId);

    // Pointing an existing site somewhere else invalidates everything derived
    // from the old address, so the site drops back to a draft.
    const changed = existing.origin !== origin || existing.canonicalUrl !== canonicalUrl;
    if (!changed) {
      const site = await prisma.site.update({
        where: { id: existing.id },
        data: { canonicalUrl, origin },
      });
      return { site, created: false };
    }

    // A target switch makes the old extraction and live-check evidence
    // misleading. Keep immutable configuration history for auditability, but
    // invalidate all target-bound derived state atomically: no old scan can
    // be selected, no old verification can appear as proof for the new site,
    // and an outstanding verification URL for the previous origin dies.
    const [site] = await prisma.$transaction([
      prisma.site.update({
        where: { id: existing.id },
        data: {
          canonicalUrl,
          origin,
          status: "DRAFT",
          platform: "UNKNOWN",
          title: null,
          publishedConfigVersionId: null,
        },
      }),
      prisma.scanRun.updateMany({
        where: { siteId: existing.id, status: { in: ["PENDING", "RUNNING", "SUCCEEDED", "PARTIAL"] } },
        data: {
          status: "FAILED",
          errorCode: "SCAN_FAILED",
          errorMessage: "The portfolio address changed before this scan could be used.",
          finishedAt: new Date(),
        },
      }),
      prisma.sitePage.deleteMany({ where: { siteId: existing.id } }),
      prisma.verificationRun.deleteMany({ where: { siteId: existing.id } }),
      prisma.verificationChallenge.deleteMany({ where: { siteId: existing.id } }),
    ]);

    return { site, created: false };
  }

  // Re-use a site this session already created for the same address rather than
  // accumulating duplicates every time someone re-pastes the same URL.
  const existing = await prisma.site.findFirst({
    where: { createdBySessionId: session.id, canonicalUrl },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { site: existing, created: false };

  const site = await prisma.site.create({
    data: {
      publicId: generatePublicSiteId(),
      createdBySessionId: session.id,
      canonicalUrl,
      origin,
      status: "DRAFT",
    },
  });

  return { site, created: true };
}

/** The site this session is currently working on, if any. */
export async function getCurrentSite(session: BuilderSession): Promise<Site | null> {
  return prisma.site.findFirst({
    where: { createdBySessionId: session.id },
    orderBy: { updatedAt: "desc" },
  });
}
