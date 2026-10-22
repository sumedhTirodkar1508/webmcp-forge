import "server-only";

import type { BuilderSession, Site } from "@/generated/prisma/client";
import { questionsRemaining } from "@/lib/ai/question-quota";
import { appOrigin } from "@/lib/env";
import { runtimeConfigSchema } from "@/lib/runtime-config";
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

/** Reads the snippet the scanner found, and whether it belongs to this site. */
function readInstalledSnippet(
  deterministic: Record<string, unknown>,
  publicId: string,
): DiscoverySummary["installedSnippet"] {
  const raw = deterministic.installedSnippet as
    | { siteId?: unknown; configVersion?: unknown }
    | null
    | undefined;
  if (!raw || typeof raw.siteId !== "string" || !raw.siteId) return null;

  const version = raw.configVersion;
  return {
    siteId: raw.siteId,
    configVersion:
      typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : null,
    matchesThisSite: raw.siteId === publicId,
  };
}

const SECTION_LABELS: Record<string, string> = {
  profile: "About you",
  projects: "Projects",
  skills: "Skills",
  experience: "Experience",
  education: "Education",
  contact: "Contact details",
  // What an owner calls it; "Navigation" read as an abstract category.
  navigation: "Menu links",
};

function summariseDiscovery(
  scan: Awaited<ReturnType<typeof getLatestScan>>,
  publicId: string,
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
    installedSnippet: readInstalledSnippet(deterministic, publicId),
  };
}

/**
 * Server-side count of natural-language demo questions left. Uses the shared
 * rule — this used to count summary rows too, so a live answer cost two.
 */
async function demoQuestionsRemaining(siteId: string): Promise<number> {
  return questionsRemaining(siteId);
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
    select: { version: true, publishedAt: true, createdAt: true, runtimeConfig: true },
  });

  const origin = appOrigin();
  const capabilities = current ? describeCapabilities(current.mapping, current.settings) : [];
  const generated = runtimeConfigSchema.safeParse(latestVersion?.runtimeConfig);
  const enabled = capabilities.filter((capability) => capability.enabled).map((capability) => capability.id);
  const settingsChanged = latestVersion !== null && (!generated.success ||
    enabled.length !== generated.data.enabledCapabilities.length ||
    enabled.some((id) => !generated.data.enabledCapabilities.includes(id)));

  return {
    siteId: site.id,
    publicId: site.publicId,
    targetUrl: site.canonicalUrl,
    origin: site.origin,
    title: site.title,
    status: site.status,
    discovery: summariseDiscovery(scan, site.publicId),
    capabilities,
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
          needsRegeneration: settingsChanged || Boolean(
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
/**
 * The state to show when the builder page loads: the site this browser was
 * last working on (remembered by id), falling back to the newest site this
 * session created.
 */
export async function getInitialBuilderState(
  session: BuilderSession,
  rememberedSiteId: string | null,
): Promise<BuilderState> {
  if (rememberedSiteId) {
    const remembered = await getBuilderState(session, rememberedSiteId);
    if (remembered.siteId) return remembered;
  }
  return getBuilderState(session);
}

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
