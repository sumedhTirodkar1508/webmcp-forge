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

/**
 * The config version the live website pins, if the scan could read it.
 *
 * This is the only thing that says what a site is ACTUALLY running; the newest
 * generated version says nothing about deployment.
 */
function detectedInstalledVersion(
  scan: Awaited<ReturnType<typeof getLatestScan>>,
  publicId: string,
): number | null {
  const deterministic = (scan?.deterministic ?? {}) as Record<string, unknown>;
  const installed = deterministic.installedSnippet as
    | { siteId?: unknown; configVersion?: unknown }
    | null
    | undefined;
  if (!installed) return null;

  // A snippet for a DIFFERENT Forge site is not this site's installation, even
  // though it is genuinely on the page.
  if (installed.siteId !== publicId) return null;

  const value = installed.configVersion;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

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
    const section = mapping[key] as { expectedCount?: number; expectedNestedCount?: number } | undefined;
    if (section?.expectedCount !== undefined) {
      if (key === "skills" && section.expectedNestedCount !== undefined) {
        found.Skills = section.expectedNestedCount;
        found["Skill groups"] = section.expectedCount;
      } else {
        found[SECTION_LABELS[key] ?? key] = section.expectedCount;
      }
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

  const latestVersion = await prisma.configVersion.findFirst({
    where: { siteId: site.id },
    orderBy: { version: "desc" },
    select: { version: true, publishedAt: true, createdAt: true },
  });

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
    installation: latestVersion
      ? {
          publicId: site.publicId,
          // The snippet always pins the version the user is being asked to
          // deploy — never "latest", which the runtime must not resolve.
          scriptTag: buildScriptTag(origin, site.publicId, latestVersion.version),
          runtimeUrl: `${origin}${RUNTIME_PATH}`,
          platform: site.platform,
          latestGeneratedVersion: latestVersion.version,
          generatedAt: (latestVersion.publishedAt ?? latestVersion.createdAt).toISOString(),
          installedVersion: detectedInstalledVersion(scan, site.publicId),
          needsRegeneration: Boolean(
            scan?.finishedAt &&
              (scan.status === "SUCCEEDED" || scan.status === "PARTIAL") &&
              scan.finishedAt > (latestVersion.publishedAt ?? latestVersion.createdAt),
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
        // Identity is the origin; anyone may load a site by id.
        where: { id: siteId },
      })
    : await prisma.site.findFirst({
        where: { createdBySessionId: session.id },
        orderBy: { updatedAt: "desc" },
      });

  if (!site) return EMPTY_BUILDER_STATE;
  return buildStateForSite(site);
}
