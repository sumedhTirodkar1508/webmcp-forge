import "server-only";

import type { BuilderSession, ScanRun, Site } from "@/generated/prisma/client";
import type { AiAttemptRecord } from "@/lib/ai/model-chain";
import { availableRequirements } from "@/lib/ai/resolve-mapping";
import { interpretScan } from "@/lib/ai/semantic";
import { recommendSettings } from "@/lib/capabilities/settings";
import { getEnv } from "@/lib/env";
import { AppError, toAppError } from "@/lib/errors";
import { asJson } from "@/lib/json";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { crawlSite } from "@/lib/scanner/crawl";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * The scan pipeline: crawl, extract, interpret, persist.
 *
 * Called identically by the UI's Scan button and by the `scan_site` WebMCP
 * builder tool — there is one implementation, so an agent and a person always
 * produce the same result.
 *
 * Anti-abuse: an anonymous session can start a bounded number of scans per hour.
 * A scan spends real money (one Gemini request) and real bandwidth, and this
 * endpoint needs no account, so leaving it uncapped would be leaving an open
 * cost endpoint on the internet.
 */

export interface ScanOutcome {
  site: Site;
  scanRun: ScanRun;
  warnings: string[];
}

async function assertScanQuota(session: BuilderSession): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.scanRun.count({
    where: {
      site: { createdBySessionId: session.id },
      startedAt: { gte: since },
    },
  });

  if (recent >= getEnv().SCAN_MAX_PER_SESSION_PER_HOUR) {
    throw new AppError(
      "RATE_LIMITED",
      "You have run a lot of scans in the last hour. Please wait a little while before scanning again.",
    );
  }
}

export async function scanSite(
  session: BuilderSession,
  siteId: string,
): Promise<ScanOutcome> {
  const site = await requireOwnedSiteFor(session, siteId);
  await assertScanQuota(session);

  const env = getEnv();

  const scanRun = await prisma.scanRun.create({
    data: { siteId: site.id, status: "RUNNING" },
  });

  const recordAttempt = async (attempt: AiAttemptRecord) => {
    await prisma.aiUsageEvent.create({
      data: {
        siteId: site.id,
        scanRunId: scanRun.id,
        purpose: "SEMANTIC_MAPPING",
        model: attempt.model,
        attempt: attempt.attempt,
        status: attempt.status,
        errorCode: attempt.errorCode ?? null,
        latencyMs: attempt.latencyMs,
      },
    });
  };

  try {
    const crawl = await crawlSite(site.canonicalUrl, {
      maxPages: env.SCAN_MAX_PAGES,
      timeoutMs: env.SCAN_REQUEST_TIMEOUT_MS,
      maxBytes: env.SCAN_MAX_HTML_BYTES,
      maxRedirects: env.SCAN_MAX_REDIRECTS,
    });

    const semantic = await interpretScan(crawl.representation, {
      onAttempt: recordAttempt,
    });

    const warnings = [...semantic.warnings];
    if (crawl.representation.lowInformation) {
      warnings.unshift(
        "This site appears to render significant content in the browser. WebMCP Forge could only inspect the HTML your server returned, so some sections may be missing.",
      );
    }
    for (const failure of crawl.failures.slice(0, 3)) {
      warnings.push(`Could not read ${failure.url} (${failure.reason.toLowerCase()}).`);
    }

    const available = availableRequirements(semantic.mapping);
    const settings = recommendSettings(available);

    const entryPage = crawl.pages[0];
    const status = crawl.failures.length > 0 ? "PARTIAL" : "SUCCEEDED";

    const [updatedSite, updatedRun] = await prisma.$transaction([
      prisma.site.update({
        where: { id: site.id },
        data: {
          platform: crawl.representation.platform.platform,
          title: entryPage?.title ?? null,
          status: site.status === "PUBLISHED" ? "PUBLISHED" : "SCANNED",
        },
      }),
      prisma.scanRun.update({
        where: { id: scanRun.id },
        data: {
          status,
          pagesScanned: crawl.pages.length,
          pagesFailed: crawl.failures.length,
          deterministic: asJson({
            platform: crawl.representation.platform,
            routePatterns: crawl.representation.routePatterns,
            navigation: crawl.representation.navigation,
            lowInformation: crawl.representation.lowInformation,
            pages: crawl.pages.map((page) => ({
              url: page.url,
              pathname: page.pathname,
              routePattern: page.routePattern,
              pageType: page.pageType,
              title: page.title,
              lowInformation: page.lowInformation,
              groupCount: page.repeatedGroups.length,
            })),
          }),
          semantic: asJson({
            mapping: semantic.mapping,
            available: [...available],
            settings,
          }),
          semanticModel: semantic.model,
          semanticAttempts: semantic.attempts.length,
          semanticFellBack: semantic.fellBack,
          warnings: asJson(warnings),
          finishedAt: new Date(),
        },
      }),
    ]);

    // Replace the page inventory wholesale — a re-scan is authoritative.
    await prisma.$transaction([
      prisma.sitePage.deleteMany({ where: { siteId: site.id } }),
      prisma.sitePage.createMany({
        data: crawl.pages.map((page) => ({
          siteId: site.id,
          url: page.url,
          pathname: page.pathname,
          routePattern: page.routePattern,
          pageType: page.pageType,
          httpStatus: page.httpStatus,
          contentType: page.contentType ?? null,
          byteSize: page.byteSize,
          title: page.title ?? null,
          lowInformation: page.lowInformation,
        })),
        skipDuplicates: true,
      }),
    ]);

    return { site: updatedSite, scanRun: updatedRun, warnings };
  } catch (error) {
    const appError = toAppError(error);
    logger.warn("scan_failed", { siteId: site.id, code: appError.code });

    await prisma.scanRun.update({
      where: { id: scanRun.id },
      data: {
        status: "FAILED",
        errorCode: appError.code,
        errorMessage: appError.message,
        finishedAt: new Date(),
      },
    });

    throw appError;
  }
}

/** The most recent scan for a site, whatever its outcome. */
export async function getLatestScan(siteId: string): Promise<ScanRun | null> {
  return prisma.scanRun.findFirst({
    where: { siteId },
    orderBy: { startedAt: "desc" },
  });
}

/** The most recent scan that actually produced a mapping. */
export async function getLatestSuccessfulScan(siteId: string): Promise<ScanRun | null> {
  return prisma.scanRun.findFirst({
    where: { siteId, status: { in: ["SUCCEEDED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
  });
}
