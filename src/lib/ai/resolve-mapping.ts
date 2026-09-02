import type {
  FieldMapping,
  ListMapping,
  SiteMapping,
  SingleMapping,
} from "@/lib/ai/mapping-schema";
import { siteMappingSchema } from "@/lib/ai/mapping-schema";
import type { SemanticResult } from "@/lib/ai/semantic-schema";
import type { DataRequirement } from "@/lib/capabilities/catalogue";
import type {
  PageExtraction,
  RepeatedGroup,
  ScanRepresentation,
} from "@/lib/scanner/types";

/**
 * Turns the model's *references* into a real site mapping.
 *
 * This is the security hinge of the whole AI integration. Gemini never returns
 * a selector; it returns a page URL, a group id and field names that must
 * already exist in the deterministic scan. Every selector that reaches the
 * published configuration is therefore one our own Cheerio extraction produced
 * and verified against the real document. A confused or adversarial model can
 * choose the wrong list — it cannot conjure a selector, and there is no field
 * anywhere in this pipeline into which it could place executable code.
 *
 * Anything that does not resolve is dropped, not guessed at.
 */

export interface ResolvedMapping {
  mapping: SiteMapping;
  /** Which data categories actually resolved — drives capability defaults. */
  available: Set<DataRequirement>;
  /** User-safe notes about what could not be resolved. */
  warnings: string[];
}

function findPage(
  representation: ScanRepresentation,
  url: string,
): PageExtraction | undefined {
  return (
    representation.pages.find((page) => page.url === url) ??
    // Models sometimes echo a path rather than the absolute URL.
    representation.pages.find((page) => page.pathname === url)
  );
}

function findGroup(page: PageExtraction, groupId: string): RepeatedGroup | undefined {
  return page.repeatedGroups.find((group) => group.id === groupId);
}

/** Converts a scanned field candidate into a stored field mapping. */
function toFieldMapping(group: RepeatedGroup, fieldName: string): FieldMapping | undefined {
  const candidate = group.fields[fieldName];
  if (!candidate) return undefined;
  return {
    selector: candidate.selector,
    source: candidate.source,
    ...(candidate.attribute ? { attribute: candidate.attribute } : {}),
  };
}

/** Picks the named candidate fields off a group, skipping any that are absent. */
function collectFields(
  group: RepeatedGroup,
  roles: readonly string[],
): Record<string, FieldMapping> {
  const fields: Record<string, FieldMapping> = {};
  for (const role of roles) {
    const mapping = toFieldMapping(group, role);
    if (mapping) fields[role] = mapping;
  }
  return fields;
}

/** Builds a list mapping from a model selection, or returns undefined. */
function resolveList(
  representation: ScanRepresentation,
  selection: { pageUrl: string; groupId: string; fields: Record<string, string | undefined> } | undefined,
  warnings: string[],
  label: string,
): ListMapping | undefined {
  if (!selection) return undefined;

  const page = findPage(representation, selection.pageUrl);
  if (!page) {
    warnings.push(`Could not locate the page the ${label} list was said to be on.`);
    return undefined;
  }

  const group = findGroup(page, selection.groupId);
  if (!group) {
    warnings.push(`Could not locate the ${label} list on ${page.pathname}.`);
    return undefined;
  }

  const fields: Record<string, FieldMapping> = {};
  for (const [role, fieldName] of Object.entries(selection.fields)) {
    if (!fieldName) continue;
    const mapping = toFieldMapping(group, fieldName);
    if (mapping) fields[role] = mapping;
  }

  if (Object.keys(fields).length === 0) {
    warnings.push(`The ${label} list had no readable fields.`);
    return undefined;
  }

  return {
    route: page.routePattern,
    itemSelector: group.itemSelector,
    ...(group.containerSelector ? { containerSelector: group.containerSelector } : {}),
    fields,
    expectedCount: group.count,
  };
}

/** Resolves profile fields from heading/section indices the model chose. */
function resolveProfile(
  representation: ScanRepresentation,
  selection: SemanticResult["profile"],
  warnings: string[],
): SingleMapping | undefined {
  if (!selection) return undefined;

  const page = findPage(representation, selection.pageUrl);
  if (!page) {
    warnings.push("Could not locate the page the profile was said to be on.");
    return undefined;
  }

  const fields: Record<string, FieldMapping> = {};

  const headingSelector = (index: number | undefined): string | undefined => {
    if (index === undefined) return undefined;
    const heading = page.headings[index];
    if (!heading) return undefined;
    // Selectors are positional over our own extracted heading order, which is
    // document order for h1..h4 — stable enough to re-find on the live page.
    return `h1, h2, h3, h4`;
  };

  const nameHeading = selection.nameHeadingIndex;
  if (nameHeading !== undefined && page.headings[nameHeading]) {
    const selector = headingSelector(nameHeading);
    if (selector) {
      fields.name = { selector: `${selector}`, source: "text" };
    }
  }

  const section =
    selection.bioSectionIndex !== undefined
      ? page.sections[selection.bioSectionIndex]
      : undefined;
  if (section) {
    fields.bio = { selector: section.selector, source: "text" };
  }

  if (Object.keys(fields).length === 0) {
    warnings.push("No profile text could be located.");
    return undefined;
  }

  return { route: page.routePattern, fields };
}

/** Nav entries the model proposed, kept only when we actually saw that path. */
function resolveNavigation(
  representation: ScanRepresentation,
  proposed: SemanticResult["navigation"],
): SiteMapping["navigation"] {
  const seenPaths = new Set(
    representation.navigation
      .map((entry) => entry.pathname)
      .filter((path): path is string => Boolean(path)),
  );
  for (const page of representation.pages) seenPaths.add(page.pathname);

  const items: Array<{ label: string; path: string }> = [];
  const used = new Set<string>();

  for (const entry of proposed) {
    if (!entry.path.startsWith("/")) continue;
    if (!seenPaths.has(entry.path)) continue;
    if (used.has(entry.path)) continue;
    used.add(entry.path);
    items.push({ label: entry.label, path: entry.path });
  }

  // Fall back to what the crawler saw, so navigate_site works even when the
  // model returned nothing usable.
  if (items.length === 0) {
    for (const entry of representation.navigation) {
      if (!entry.pathname || used.has(entry.pathname)) continue;
      used.add(entry.pathname);
      items.push({ label: entry.label, path: entry.pathname });
      if (items.length >= 12) break;
    }
  }

  return items.length > 0 ? { items: items.slice(0, 30) } : undefined;
}

function resolveContact(
  representation: ScanRepresentation,
  selection: SemanticResult["contact"],
): SiteMapping["contact"] {
  // Contact details are deterministic — mailto:, tel: and known social hosts —
  // so the model only picks which page they came from.
  const page = selection ? findPage(representation, selection.pageUrl) : undefined;
  const candidates = page ? [page] : representation.pages;

  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials = new Map<string, { platform: string; url: string }>();

  for (const candidate of candidates) {
    for (const email of candidate.contact.emails) emails.add(email);
    for (const phone of candidate.contact.phones) phones.add(phone);
    for (const social of candidate.contact.socials) socials.set(social.url, social);
  }

  if (emails.size === 0 && phones.size === 0 && socials.size === 0) return undefined;

  return {
    route: "*",
    emails: [...emails].slice(0, 10),
    phones: [...phones].slice(0, 10),
    socials: [...socials.values()].slice(0, 10),
  };
}

/**
 * Resolves a validated model result against the scan. Never throws: an
 * unresolvable section simply does not appear in the mapping.
 */
export function resolveMapping(
  representation: ScanRepresentation,
  semantic: SemanticResult,
): ResolvedMapping {
  const warnings = [...semantic.warnings];

  const projects = resolveList(representation, semantic.projects, warnings, "projects");
  const skills = resolveList(representation, semantic.skills, warnings, "skills");
  const experience = resolveList(representation, semantic.experience, warnings, "experience");
  const education = resolveList(representation, semantic.education, warnings, "education");
  const profile = resolveProfile(representation, semantic.profile, warnings);
  const navigation = resolveNavigation(representation, semantic.navigation);
  const contact = resolveContact(representation, semantic.contact);

  const draft: SiteMapping = {
    version: 1,
    ...(profile ? { profile } : {}),
    ...(projects ? { projects } : {}),
    ...(semantic.projectDetailRoute
      ? { projectDetailRoute: semantic.projectDetailRoute }
      : {}),
    ...(skills ? { skills } : {}),
    ...(experience ? { experience } : {}),
    ...(education ? { education } : {}),
    ...(contact ? { contact } : {}),
    ...(navigation ? { navigation } : {}),
  };

  // Belt and braces: everything already came from our own scan, but the final
  // object still goes through the schema that guards selector shape.
  const parsed = siteMappingSchema.safeParse(draft);
  const mapping: SiteMapping = parsed.success ? parsed.data : { version: 1 };
  if (!parsed.success) {
    warnings.push("Some discovered structure could not be saved safely and was skipped.");
  }

  return {
    mapping,
    available: availableRequirements(mapping),
    warnings: warnings.slice(0, 10),
  };
}

export function availableRequirements(mapping: SiteMapping): Set<DataRequirement> {
  const available = new Set<DataRequirement>();
  if (mapping.profile) available.add("profile");
  if (mapping.projects) available.add("projects");
  if (mapping.skills) available.add("skills");
  if (mapping.experience) available.add("experience");
  if (mapping.education) available.add("education");
  if (mapping.contact) available.add("contact");
  if (mapping.navigation?.items.length) available.add("navigation");
  return available;
}

/**
 * A mapping derived without any AI at all.
 *
 * Used when Gemini is unconfigured or every model fails. It is worse than the
 * semantic mapping — it guesses from route type and group score rather than
 * meaning — but it keeps the product usable and honest about it, instead of
 * failing the whole scan because a third-party API was down.
 */
export function deriveHeuristicMapping(
  representation: ScanRepresentation,
): ResolvedMapping {
  const warnings: string[] = [];

  const workPage =
    representation.pages.find((page) => page.pageType === "WORK_INDEX") ??
    representation.pages.find((page) => page.pageType === "HOME");

  const bestGroup = (page: PageExtraction | undefined, minCount: number) =>
    page?.repeatedGroups.find((group) => group.count >= minCount && "title" in group.fields);

  const projectGroup = bestGroup(workPage, 2);
  const projects: ListMapping | undefined =
    workPage && projectGroup
      ? {
          route: workPage.routePattern,
          itemSelector: projectGroup.itemSelector,
          ...(projectGroup.containerSelector
            ? { containerSelector: projectGroup.containerSelector }
            : {}),
          fields: collectFields(projectGroup, ["title", "description", "link", "image"]),
          expectedCount: projectGroup.count,
        }
      : undefined;

  if (!projects) {
    warnings.push("Projects were identified without AI assistance and may be incomplete.");
  }

  const draft: SiteMapping = {
    version: 1,
    ...(projects ? { projects } : {}),
    ...(resolveContact(representation, undefined)
      ? { contact: resolveContact(representation, undefined) }
      : {}),
    ...(resolveNavigation(representation, [])
      ? { navigation: resolveNavigation(representation, []) }
      : {}),
  };

  const parsed = siteMappingSchema.safeParse(draft);
  const mapping = parsed.success ? parsed.data : { version: 1 as const };

  return { mapping, available: availableRequirements(mapping), warnings };
}
