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
    warnings.push(`We couldn't find your ${label} on the pages we read, so agents won't be able to list them yet.`);
    return undefined;
  }

  const group = findGroup(page, selection.groupId);
  if (!group) {
    warnings.push(`We couldn't pin down your ${label} on ${page.pathname}, so agents won't be able to list them yet.`);
    return undefined;
  }

  const fields: Record<string, FieldMapping> = {};
  for (const [role, fieldName] of Object.entries(selection.fields)) {
    if (!fieldName) continue;
    const mapping = toFieldMapping(group, fieldName);
    if (mapping) fields[role] = mapping;
  }

  const findField = (
    preferredNames: string[],
    requiredHints: string[] = [],
  ): string | undefined =>
    preferredNames.find((name) => Boolean(group.fields[name])) ??
    Object.entries(group.fields).find(([, field]) =>
      requiredHints.every((hint) => field.hints?.includes(hint)),
    )?.[0];
  const addFallback = (
    role: string,
    preferredNames: string[],
    requiredHints: string[] = [],
  ) => {
    if (fields[role]) return;
    const fieldName = findField(preferredNames, requiredHints);
    if (!fieldName) return;
    const mapping = toFieldMapping(group, fieldName);
    if (mapping) fields[role] = mapping;
  };

  // Once the model has safely selected the semantic group, fill omitted roles
  // from scanner-owned structural hints. Structured output models often leave
  // optional fields blank even when the candidate is unambiguous.
  if (label === "projects") {
    addFallback("title", ["title"], ["heading"]);
    addFallback("description", ["f2", "description"], ["prose"]);
    addFallback("link", ["link"], ["link"]);
    addFallback("image", ["image"], ["image"]);
    addFallback("tags", ["nestedList"], ["nested list"]);
  } else if (label === "skills") {
    addFallback("category", ["title"], ["heading"]);
    addFallback("items", ["nestedList"], ["nested list"]);
  } else if (label === "experience") {
    addFallback("role", ["title"], ["heading"]);
    addFallback("organization", [], ["inline text", "first value"]);
    addFallback("dates", ["date", "dateText"], ["date"]);
    addFallback("summary", ["description"], ["prose"]);
  } else if (label === "education") {
    addFallback("degree", ["title"], ["heading"]);
    addFallback("institution", [], ["inline text", "first value"]);
    addFallback("dates", ["date", "dateText"], ["date"]);
    addFallback("summary", ["description"], ["prose"]);
  }

  if (Object.keys(fields).length === 0) {
    warnings.push(`We found your ${label}, but couldn't read their details reliably.`);
    return undefined;
  }

  const nestedCount = label === "skills"
    ? Object.values(group.fields).find(
        (candidate) => candidate.selector === fields.items?.selector && candidate.source === fields.items?.source,
      )?.nestedItemCount
    : undefined;

  return {
    route: page.routePattern,
    itemSelector: group.itemSelector,
    ...(group.containerSelector ? { containerSelector: group.containerSelector } : {}),
    fields,
    expectedCount: group.count,
    ...(nestedCount ? { expectedNestedCount: nestedCount } : {}),
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
    warnings.push("We couldn't find a clear introduction about you, so \"Learn about me\" may be limited.");
    return undefined;
  }

  const fields: Record<string, FieldMapping> = {};

  const headingSelector = (index: number | undefined): string | undefined => {
    if (index === undefined) return undefined;
    const heading = page.headings[index];
    if (!heading) return undefined;
    return heading.selector;
  };

  const nameHeading = selection.nameHeadingIndex;
  if (nameHeading !== undefined && page.headings[nameHeading]) {
    const selector = headingSelector(nameHeading);
    if (selector) {
      fields.name = { selector: `${selector}`, source: "text" };
    }
  }

  const headlineHeading = selection.headlineHeadingIndex;
  if (headlineHeading !== undefined && page.headings[headlineHeading]) {
    const chosen = page.headings[headlineHeading];
    const belongsToCollection = page.sections.some(
      (candidate) =>
        candidate.heading === chosen.text && (candidate.repeatedItemCount ?? 0) >= 4,
    );
    const selector = belongsToCollection ? undefined : headingSelector(headlineHeading);
    if (selector && selector !== fields.name?.selector) {
      fields.headline = { selector, source: "text" };
    }
    if (belongsToCollection) {
      warnings.push("We skipped a headline that looked like part of a list rather than your introduction.");
    }
  }

  const section =
    selection.bioSectionIndex !== undefined
      ? page.sections[selection.bioSectionIndex]
      : undefined;
  // Large repeated collections are never a person's biography. This scanner-
  // owned guard catches a bad semantic selection without relying on English
  // section names.
  if (section && (section.repeatedItemCount ?? 0) < 4) {
    fields.bio = { selector: section.selector, source: "text" };
  } else if (section) {
    warnings.push("We skipped a bio that looked like part of a list rather than your introduction.");
  }

  if (Object.keys(fields).length === 0) {
    warnings.push("We couldn't find an introduction about you on the pages we read.");
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
      .map((entry) => entry.path ?? entry.pathname)
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
      const path = entry.path ?? entry.pathname;
      if (!entry.label.trim() || !path || used.has(path)) continue;
      used.add(path);
      items.push({ label: entry.label, path });
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
 * Picks the contact form to expose, straight from the deterministic scan.
 *
 * The model has no say here at all. Form selectors are structural and
 * security-relevant — they decide what the runtime will type into and submit —
 * so they come only from Cheerio extraction that already verified them against
 * the real document. A SUPPORTED form is preferred over an UNCERTAIN one.
 */
function resolveContactForm(
  representation: ScanRepresentation,
): SiteMapping["contactForm"] {
  const candidates: Array<{ page: PageExtraction; form: NonNullable<PageExtraction["contact"]["forms"]>[number] }> = [];

  for (const page of representation.pages) {
    for (const form of page.contact.forms ?? []) {
      if (form.support === "UNSUPPORTED") continue;
      if (!form.fields.message) continue;
      candidates.push({ page, form });
    }
  }

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const rank = (support: string) => (support === "SUPPORTED" ? 0 : 1);
    const bySupport = rank(a.form.support) - rank(b.form.support);
    if (bySupport !== 0) return bySupport;
    // Prefer a page that is actually about contact.
    const contactness = (page: PageExtraction) => (page.pageType === "CONTACT" ? 0 : 1);
    return contactness(a.page) - contactness(b.page);
  });

  const chosen = candidates[0]!;
  const message = chosen.form.fields.message;
  if (!message) return undefined;

  return {
    route: chosen.page.routePattern,
    formSelector: chosen.form.formSelector,
    ...(chosen.form.submitSelector ? { submitSelector: chosen.form.submitSelector } : {}),
    fields: {
      message,
      ...(chosen.form.fields.name ? { name: chosen.form.fields.name } : {}),
      ...(chosen.form.fields.email ? { email: chosen.form.fields.email } : {}),
      ...(chosen.form.fields.subject ? { subject: chosen.form.fields.subject } : {}),
    },
    support: chosen.form.support,
    reasons: chosen.form.reasons,
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
  const contactForm = resolveContactForm(representation);

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
    ...(contactForm ? { contactForm } : {}),
    ...(navigation ? { navigation } : {}),
  };

  // Belt and braces: everything already came from our own scan, but the final
  // object still goes through the schema that guards selector shape.
  const parsed = siteMappingSchema.safeParse(draft);
  const mapping: SiteMapping = parsed.success ? parsed.data : { version: 1 };
  if (!parsed.success) {
    warnings.push("Some of what we found couldn't be saved safely, so it was left out.");
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
  // An UNSUPPORTED form is detected but unusable, so it must not make the
  // contact-message capabilities selectable.
  if (mapping.contactForm && mapping.contactForm.support !== "UNSUPPORTED") {
    available.add("contact_form");
  }
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

  const allGroups = representation.pages.flatMap((page) =>
    page.repeatedGroups.map((group) => ({ page, group })),
  );
  const contextText = (group: RepeatedGroup) =>
    [group.context?.sectionId, group.context?.ariaLabel, group.context?.heading]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  const fallbackFieldName = (
    group: RepeatedGroup,
    preferredNames: string[],
    requiredHints: string[] = [],
  ) =>
    preferredNames.find((name) => Boolean(group.fields[name])) ??
    Object.entries(group.fields).find(([, field]) =>
      requiredHints.every((hint) => field.hints?.includes(hint)),
    )?.[0];
  const pick = (pattern: RegExp, structural: (group: RepeatedGroup) => boolean) =>
    allGroups.find(({ group }) => pattern.test(contextText(group)) && structural(group)) ??
    allGroups.find(({ group }) => structural(group));

  const projectCandidate = pick(
    /(project|work|portfolio|case.?stud|projet|proyecto|arbeit)/i,
    (group) =>
      group.count >= 2 &&
      Boolean(group.fields.title) &&
      Boolean(group.fields.link || group.fields.image),
  );
  const projectGroup = projectCandidate?.group;
  const projectPage = projectCandidate?.page ?? workPage;
  const projects: ListMapping | undefined =
    projectPage && projectGroup
      ? {
          route: projectPage.routePattern,
          itemSelector: projectGroup.itemSelector,
          ...(projectGroup.containerSelector
            ? { containerSelector: projectGroup.containerSelector }
            : {}),
          fields: Object.fromEntries(
            Object.entries({
              title: fallbackFieldName(projectGroup, ["title"], ["heading"]),
              description: fallbackFieldName(projectGroup, ["f2", "description"], ["prose"]),
              link: fallbackFieldName(projectGroup, ["link"], ["link"]),
              image: fallbackFieldName(projectGroup, ["image"], ["image"]),
              tags: fallbackFieldName(projectGroup, ["nestedList"], ["nested list"]),
            }).flatMap(([role, fieldName]) => {
              if (!fieldName) return [];
              const mapping = toFieldMapping(projectGroup, fieldName);
              return mapping ? [[role, mapping]] : [];
            }),
          ),
          expectedCount: projectGroup.count,
        }
      : undefined;

  const skillCandidate = pick(
    /(skill|stack|capabilit|technolog|comp.tence|habilidad)/i,
    (group) =>
      group.count >= 2 && Boolean(group.fields.title) && Boolean(group.fields.nestedList),
  );
  const experienceCandidate = pick(
    /(experience|career|employment|work.?history|exp.rience|erfahrung)/i,
    (group) =>
      group.count >= 2 &&
      Boolean(group.fields.title) &&
      Boolean(group.fields.date || group.fields.dateText),
  );
  const educationCandidate = pick(
    /(education|academic|degree|school|universit|formation|ausbildung)/i,
    (group) =>
      group.count >= 2 &&
      Boolean(group.fields.title) &&
      Boolean(group.fields.date || group.fields.dateText) &&
      group !== experienceCandidate?.group,
  );

  const makeList = (
    candidate: (typeof allGroups)[number] | undefined,
    roles: Record<string, string | undefined>,
  ): ListMapping | undefined => {
    if (!candidate) return undefined;
    const fields: Record<string, FieldMapping> = {};
    for (const [role, fieldName] of Object.entries(roles)) {
      if (!fieldName) continue;
      const field = toFieldMapping(candidate.group, fieldName);
      if (field) fields[role] = field;
    }
    if (Object.keys(fields).length === 0) return undefined;
    const nestedCount = roles.items ? candidate.group.fields[roles.items]?.nestedItemCount : undefined;
    return {
      route: candidate.page.routePattern,
      itemSelector: candidate.group.itemSelector,
      ...(candidate.group.containerSelector
        ? { containerSelector: candidate.group.containerSelector }
        : {}),
      fields,
      expectedCount: candidate.group.count,
      ...(nestedCount ? { expectedNestedCount: nestedCount } : {}),
    };
  };

  const skills = makeList(skillCandidate, { category: "title", items: "nestedList" });
  const experience = makeList(experienceCandidate, {
    role: "title",
    organization: experienceCandidate
      ? fallbackFieldName(experienceCandidate.group, [], ["inline text", "first value"])
      : undefined,
    dates: experienceCandidate?.group.fields.date ? "date" : "dateText",
    summary: "description",
  });
  const education = makeList(educationCandidate, {
    degree: "title",
    institution: educationCandidate
      ? fallbackFieldName(educationCandidate.group, [], ["inline text", "first value"])
      : undefined,
    dates: educationCandidate?.group.fields.date ? "date" : "dateText",
    summary: "description",
  });

  const profilePage = representation.pages.find((page) => page.headings.some((h) => h.level === 1));
  const profileHeadingIndex = profilePage?.headings.findIndex((heading) => heading.level === 1);
  const profileSectionIndex = profilePage?.sections.findIndex(
    (section) => (section.repeatedItemCount ?? 0) < 4,
  );
  const profile =
    profilePage && profileHeadingIndex !== undefined && profileHeadingIndex >= 0
      ? resolveProfile(
          representation,
          {
            pageUrl: profilePage.url,
            nameHeadingIndex: profileHeadingIndex,
            ...(profileSectionIndex !== undefined && profileSectionIndex >= 0
              ? { bioSectionIndex: profileSectionIndex }
              : {}),
            confidence: 0.4,
          },
          warnings,
        )
      : undefined;

  if (!projects) {
    warnings.push("Your projects were detected without AI help, so the list may be incomplete. Scanning again later may improve it.");
  }

  const draft: SiteMapping = {
    version: 1,
    ...(profile ? { profile } : {}),
    ...(projects ? { projects } : {}),
    ...(skills ? { skills } : {}),
    ...(experience ? { experience } : {}),
    ...(education ? { education } : {}),
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
