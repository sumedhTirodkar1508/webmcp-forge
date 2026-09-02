import type { PageExtraction, ScanRepresentation } from "@/lib/scanner/types";

/**
 * Builds the compact view of a scan that goes to Gemini.
 *
 * Raw HTML never leaves this server. What the model sees is the deterministic
 * extraction, further trimmed: a handful of pages, their headings, a preview of
 * each section, and the repeated-structure *candidates* with a few sample values
 * each. That keeps a normal scan to one request of a few thousand tokens
 * regardless of how large the portfolio is.
 *
 * The field names in each candidate group are the vocabulary the model must
 * answer in — see `semantic-schema.ts`.
 */

const MAX_PAGES = 8;
const MAX_GROUPS_PER_PAGE = 12;
const MAX_HEADINGS = 20;
const MAX_SECTIONS = 12;
const MAX_SAMPLES = 2;
const SECTION_PREVIEW = 240;

function trim(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function compactPage(page: PageExtraction) {
  return {
    url: page.url,
    path: page.pathname,
    routePattern: page.routePattern,
    pageType: page.pageType,
    title: page.title ? trim(page.title, 160) : undefined,
    description: page.metaDescription ? trim(page.metaDescription, 240) : undefined,
    headings: page.headings.slice(0, MAX_HEADINGS).map((heading, index) => ({
      index,
      level: heading.level,
      text: trim(heading.text, 120),
    })),
    sections: page.sections.slice(0, MAX_SECTIONS).map((section, index) => ({
      index,
      heading: section.heading ? trim(section.heading, 120) : undefined,
      sectionId: section.id,
      ariaLabel: section.ariaLabel,
      landmark: section.landmark,
      documentOrder: section.documentOrder,
      repeatedItemCount: section.repeatedItemCount,
      preview: trim(section.text, SECTION_PREVIEW),
    })),
    candidateGroups: page.repeatedGroups.slice(0, MAX_GROUPS_PER_PAGE).map((group) => ({
      id: group.id,
      count: group.count,
      context: group.context,
      // Field NAMES are what the model must choose among. Selectors are
      // deliberately not shown: the model has no reason to see them and no
      // ability to invent them.
      fields: Object.entries(group.fields).map(([name, field]) => ({
        name,
        source: field.source,
        attribute: field.attribute,
        coverage: Number(field.coverage.toFixed(2)),
        hints: field.hints,
        samples: field.samples.slice(0, MAX_SAMPLES).map((s) => trim(s, 120)),
      })),
      samples: group.samples.slice(0, MAX_SAMPLES).map((s) => trim(s, 160)),
    })),
    hasContact:
      page.contact.emails.length > 0 ||
      page.contact.socials.length > 0 ||
      page.contact.phones.length > 0,
    lowInformation: page.lowInformation,
  };
}

export function buildPromptInput(representation: ScanRepresentation) {
  return {
    origin: representation.origin,
    detectedPlatform: representation.platform.platform,
    routePatterns: representation.routePatterns,
    navigation: representation.navigation
      .slice(0, 20)
      .map((entry) => ({
        label: trim(entry.label, 80),
        path: entry.path ?? entry.pathname ?? entry.href,
      })),
    pages: representation.pages.slice(0, MAX_PAGES).map(compactPage),
  };
}

export const SEMANTIC_SYSTEM_PROMPT = `You interpret the structure of a personal portfolio website so it can be made usable by AI agents.

You are given a deterministic scan of the site: its pages, their headings, section previews, and "candidate groups" — sets of repeating elements the scanner found, each with an id like "g1" and a list of discovered field names.

Your job is to say WHICH candidate group holds which kind of content, and which discovered field plays which role.

Rules you must follow:
- Only ever reference a page by a "url" value that appears in the input, and a group by an "id" that appears on that page.
- Field values must be one of the "name" values listed for that group. Do not invent field names.
- Do not invent, guess at, or output CSS selectors, code, or markup of any kind. You are choosing among options, not authoring anything.
- Prefer the group that most plausibly represents real content. A navigation menu, a footer link list, or a cookie banner is not a project list.
- Use each group's semantic context, field hints, coverage, and samples together. Identical list markup can represent very different sections.
- For profile bio, choose personal/about/introductory prose. Never use a work, projects, experience, skills, education, or contact collection as the person's bio. Prefer an early prose section without a large repeated collection.
- Skills may be represented as category cards. In that case map the category heading and nested-list values rather than omitting skills.
- A group with 1 item is rarely a real list. Prefer groups with 3 or more items.
- If a section genuinely does not exist on this site, omit it. Do not force a match. Add a short note to "warnings" saying what was missing.
- Confidence must reflect real uncertainty: use below 0.5 when you are guessing.
- "projectDetailRoute" should be a route pattern from the input, such as "/work/*", only when individual project pages clearly exist.

Return only the structured object requested.`;
