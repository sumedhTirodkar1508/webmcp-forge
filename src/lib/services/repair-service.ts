import "server-only";

import type { ListMapping, SiteMapping } from "@/lib/ai/mapping-schema";
import { siteMappingSchema } from "@/lib/ai/mapping-schema";
import type { BuilderSession } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { loadCurrentSettings, generateConfiguration } from "@/lib/services/config-service";
import { scanSite } from "@/lib/services/scan-service";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * AI-assisted mapping repair.
 *
 * When a verification check reports that a saved selector no longer matches
 * anything, the site has usually been redesigned. Repair re-runs the ordinary
 * secure scan — the same deterministic extraction and the same semantic mapper,
 * not a second engine — and shows the owner what changed before anything is
 * published.
 *
 * The safety properties that matter:
 *
 *   - nothing on the owner's website is edited, ever;
 *   - nothing is published silently: `previewRepair` only proposes;
 *   - the previously published configuration is never mutated, because config
 *     versions are immutable — applying a repair creates a new version;
 *   - if the proposal fails its checks, the existing published config stays
 *     active and serving.
 */

/** A proposed selector must match something, and not everything. */
const MIN_MATCHES = 1;
const MAX_PLAUSIBLE_MATCHES = 500;

export interface RepairChange {
  section: string;
  status: "recovered" | "unchanged" | "still_broken" | "removed" | "added";
  /** Plain-language summary for a non-technical owner. */
  summary: string;
  /** Advanced detail — shown only behind a disclosure. */
  previousSelector?: string;
  proposedSelector?: string;
  previousCount?: number;
  proposedCount?: number;
}

export interface RepairPreview {
  /** True when the proposal is safe to apply. */
  applicable: boolean;
  changes: RepairChange[];
  warnings: string[];
  /** Sections verification reported as matching nothing. */
  brokenSections: string[];
}

const LIST_SECTIONS = ["projects", "skills", "experience", "education"] as const;
type ListSection = (typeof LIST_SECTIONS)[number];

function listOf(mapping: SiteMapping, section: ListSection): ListMapping | undefined {
  return mapping[section];
}

/**
 * Deterministic sanity checks on a proposed mapping.
 *
 * The semantic mapper can only reference candidates the scanner produced, so a
 * selector here is already scanner-owned. These checks catch the remaining
 * failure mode: a structurally valid mapping that points at the wrong thing.
 */
function candidateIsPlausible(candidate: ListMapping | undefined): boolean {
  if (!candidate) return false;
  const count = candidate.expectedCount ?? 0;
  if (count < MIN_MATCHES || count > MAX_PLAUSIBLE_MATCHES) return false;
  // A mapping with no readable fields would produce empty tool results.
  if (Object.keys(candidate.fields).length === 0) return false;
  // A selector that matches the whole document is never a content list.
  if (/^(\*|html|body)$/i.test(candidate.itemSelector.trim())) return false;
  return true;
}

/** Which sections the last verification found matching nothing. */
async function brokenSectionsFor(siteId: string): Promise<string[]> {
  const latest = await prisma.verificationRun.findFirst({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    select: { liveCounts: true },
  });
  const counts = (latest?.liveCounts ?? {}) as Record<string, number>;
  return Object.entries(counts)
    .filter(([, value]) => value === 0)
    .map(([key]) => key);
}

/**
 * Re-scans and proposes a repair, WITHOUT publishing.
 *
 * The scan is the normal one, so it inherits every SSRF protection and the
 * ordinary bounded crawl.
 */
export async function previewRepair(
  session: BuilderSession,
  siteId: string,
): Promise<RepairPreview> {
  const site = await requireOwnedSiteFor(session, siteId);

  const before = await loadCurrentSettings(site);
  if (!before) {
    throw new AppError("CONFLICT", "Scan your site before repairing its mappings.");
  }

  const brokenSections = await brokenSectionsFor(site.id);

  // The ordinary scan pipeline — deterministic extraction plus the existing
  // semantic mapper. No second mapping engine.
  await scanSite(session, site.id);

  const refreshed = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
  const after = await loadCurrentSettings(refreshed);
  if (!after) {
    throw new AppError("SCAN_FAILED", "The repair scan did not produce a usable mapping.");
  }

  const parsed = siteMappingSchema.safeParse(after.mapping);
  if (!parsed.success) {
    return {
      applicable: false,
      changes: [],
      warnings: ["The repair scan produced a mapping that could not be validated safely."],
      brokenSections,
    };
  }

  const changes: RepairChange[] = [];
  const warnings: string[] = [];
  let recoveredAny = false;

  for (const section of LIST_SECTIONS) {
    const previous = listOf(before.mapping, section);
    const proposed = listOf(parsed.data, section);

    if (!previous && !proposed) continue;

    if (previous && !proposed) {
      changes.push({
        section,
        status: "removed",
        summary: `${section} could no longer be found on your site.`,
        previousSelector: previous.itemSelector,
        previousCount: previous.expectedCount,
      });
      warnings.push(`The new scan could not find ${section} at all.`);
      continue;
    }

    if (!previous && proposed) {
      changes.push({
        section,
        status: "added",
        summary: `${section} were found for the first time (${proposed.expectedCount ?? 0} items).`,
        proposedSelector: proposed.itemSelector,
        proposedCount: proposed.expectedCount,
      });
      recoveredAny = true;
      continue;
    }

    if (!previous || !proposed) continue;

    const wasBroken = brokenSections.includes(section);
    const selectorChanged = previous.itemSelector !== proposed.itemSelector;

    if (!selectorChanged && !wasBroken) {
      changes.push({
        section,
        status: "unchanged",
        summary: `${section} unchanged.`,
        previousSelector: previous.itemSelector,
        proposedCount: proposed.expectedCount,
      });
      continue;
    }

    if (candidateIsPlausible(proposed)) {
      changes.push({
        section,
        status: "recovered",
        summary: `${section} mapping recovered — ${proposed.expectedCount ?? 0} items found.`,
        previousSelector: previous.itemSelector,
        proposedSelector: proposed.itemSelector,
        previousCount: previous.expectedCount,
        proposedCount: proposed.expectedCount,
      });
      recoveredAny = true;
    } else {
      changes.push({
        section,
        status: "still_broken",
        summary: `${section} could not be recovered automatically.`,
        previousSelector: previous.itemSelector,
        proposedSelector: proposed.itemSelector,
      });
      warnings.push(`${section} still does not map to anything usable.`);
    }
  }

  return {
    applicable: recoveredAny,
    changes,
    warnings,
    brokenSections,
  };
}

/**
 * Applies the repair by publishing a NEW immutable configuration version.
 *
 * Separate from `previewRepair` on purpose: the owner sees the differences and
 * chooses. Nothing is published until they do.
 */
export async function applyRepair(
  session: BuilderSession,
  siteId: string,
): Promise<{ configVersion: number }> {
  const site = await requireOwnedSiteFor(session, siteId);

  const current = await loadCurrentSettings(site);
  if (!current) {
    throw new AppError("CONFLICT", "There is nothing to publish yet.");
  }

  // Publishing creates a new version and repoints the site at it; the previous
  // version stays exactly as it was.
  const result = await generateConfiguration(session, site.id);
  return { configVersion: result.configVersion.version };
}
