import "server-only";

import type { BuilderSession, Site } from "@/generated/prisma/client";
import { appOrigin, getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import type { PlatformFingerprint, PlatformId } from "@/lib/scanner/types";
import {
  describeCapabilities,
  loadCurrentSettings,
} from "@/lib/services/config-service";
import { buildScriptTag, RUNTIME_PATH } from "@/lib/services/install-service";
import { getLatestScan } from "@/lib/services/scan-service";
import {
  EMPTY_BUILDER_STATE,
  type BuilderState,
  type DiscoverySummary,
} from "@/lib/services/types";
import { getVerificationState } from "@/lib/services/verification-service";

/**
 * Assembles the single builder-state view.
 *
 * Both the page render and every WebMCP builder tool end their work by calling
 * this, so the agent's `get_scan_summary` and the panel on screen are literally
 * the same object. Nothing here reaches for a request — it is pure aggregation
 * over the database.
 */

const SECTION_LABELS: Record<string, string> = {
  profile: "About you",
  projects: "Projects",
  skills: "Skills",
  experience: "Experience",
  education: "Education",
  contact: "Contact details",
  navigation: "Navigation",
};

function summariseDiscovery(
  scan: Awaited<ReturnType<typeof getLatestScan>>,
): DiscoverySummary | null {
  if (
    !scan ||
    (scan.status !== "SUCCEEDED" && scan.status !== "PARTIAL") ||
    !scan.semantic ||
    typeof scan.semantic !== "object"
  ) {
    return null;
  }

  const deterministic = (scan.deterministic ?? {}) as Record<string, unknown>;
  const semantic = scan.semantic as Record<string, unknown>;
  const mapping = (semantic.mapping ?? {}) as Record<string, unknown>;
  const available = Array.isArray(semantic.available) ? (semantic.available as string[]) : [];

  const fingerprint = deterministic.platform as PlatformFingerprint | undefined;

  const found: Record<string, number> = {};
  for (const key of ["projects", "skills", "experience", "education"] as const) {
    const section = mapping[key] as { expectedCount?: number } | undefined;
    if (section?.expectedCount !== undefined) {
      found[SECTION_LABELS[key] ?? key] = section.expectedCount;
    }
  }
  if (mapping.navigation) {
    const nav = mapping.navigation as { items?: unknown[] };
    found[SECTION_LABELS.navigation!] = nav.items?.length ?? 0;
  }

  const missing = Object.entries(SECTION_LABELS)
    .filter(([key]) => key !== "navigation" && !available.includes(key))
    .map(([, label]) => label);

  return {
    platform: (fingerprint?.platform ?? "UNKNOWN") as PlatformId,
    platformConfidence: fingerprint?.confidence ?? 0,
    pagesScanned: scan.pagesScanned,
    routePatterns: Array.isArray(deterministic.routePatterns)
      ? (deterministic.routePatterns as string[])
      : [],
    found,
    missing,
    warnings: Array.isArray(scan.warnings) ? (scan.warnings as string[]) : [],
    lowInformation: deterministic.lowInformation === true,
    usedAi: Boolean(scan.semanticModel),
    aiModel: scan.semanticModel,
    aiFellBack: scan.semanticFellBack,
    scannedAt: scan.finishedAt?.toISOString() ?? scan.startedAt.toISOString(),
  };
}

/** Server-side count of natural-language demo questions already spent. */
async function demoQuestionsRemaining(siteId: string): Promise<number> {
  const limit = getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS;
  const used = await prisma.aiUsageEvent.count({
    where: { siteId, purpose: "NL_DEMO", status: "SUCCESS" },
  });
  return Math.max(0, limit - used);
}

export async function buildStateForSite(site: Site): Promise<BuilderState> {
  const [scan, current, verification, remaining] = await Promise.all([
    getLatestScan(site.id),
    loadCurrentSettings(site),
    getVerificationState(site.id),
    demoQuestionsRemaining(site.id),
  ]);

  const publishedVersion = site.publishedConfigVersionId
    ? await prisma.configVersion.findUnique({
        where: { id: site.publishedConfigVersionId },
        select: { version: true, publishedAt: true },
      })
    : null;

  const origin = appOrigin();

  return {
    siteId: site.id,
    publicId: site.publicId,
    targetUrl: site.canonicalUrl,
    origin: site.origin,
    title: site.title,
    status: site.status,
    discovery: summariseDiscovery(scan),
    capabilities: current ? describeCapabilities(current.mapping, current.settings) : [],
    installation: publishedVersion
      ? {
          publicId: site.publicId,
          scriptTag: buildScriptTag(origin, site.publicId),
          runtimeUrl: `${origin}${RUNTIME_PATH}`,
          platform: site.platform,
          configVersion: publishedVersion.version,
          publishedAt: publishedVersion.publishedAt?.toISOString() ?? null,
          needsRegeneration: Boolean(
            scan?.finishedAt &&
              (scan.status === "SUCCEEDED" || scan.status === "PARTIAL") &&
              publishedVersion.publishedAt &&
              scan.finishedAt > publishedVersion.publishedAt,
          ),
        }
      : null,
    verification,
    demoQuestionsRemaining: remaining,
  };
}

/** The state for the session's current site, or an empty state. */
export async function getBuilderState(
  session: BuilderSession,
  siteId?: string,
): Promise<BuilderState> {
  const site = siteId
    ? await prisma.site.findFirst({
        where: { id: siteId, createdBySessionId: session.id },
      })
    : await prisma.site.findFirst({
        where: { createdBySessionId: session.id },
        orderBy: { updatedAt: "desc" },
      });

  if (!site) return EMPTY_BUILDER_STATE;
  return buildStateForSite(site);
}
