/**
 * Deterministic HTML extraction.
 *
 * Turns one fetched HTML page into a `PageExtraction`, and merges a set of
 * `PageExtraction`s into a site-level `ScanRepresentation`. Everything here
 * is pure and synchronous: no network, no DOM globals, only Cheerio over a
 * string of HTML that may be hostile (untrusted third-party markup), so
 * every collection is capped and every string is truncated.
 */

import { load } from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";

import { fingerprintPlatform, mergeFingerprints } from "@/lib/scanner/platform";
import {
  inferPageType,
  inferRoutePattern,
  summarizeRoutePatterns,
} from "@/lib/scanner/routes";
import type {
  ContactSignals,
  Heading,
  NavLink,
  PageExtraction,
  PageSection,
  RepeatedField,
  RepeatedGroup,
  ScanRepresentation,
} from "@/lib/scanner/types";

// ---------------------------------------------------------------------------
// Cheerio node types.
//
// Cheerio's public entry point re-exports `Cheerio`/`CheerioAPI` but not the
// underlying `domhandler` node types (`Element`/`AnyNode`) themselves, and
// `domhandler` is only a transitive dependency here (pnpm's strict linking
// means importing it by name from this package would not resolve). These
// aliases pull the exact node types out of Cheerio's own method signatures
// instead — `children()` is typed to always return element nodes, and
// `contents()` is typed to return any node (comments included) — via a
// purely type-level lookup, so nothing here exists at runtime.
// ---------------------------------------------------------------------------

type CheerioElement = ReturnType<Cheerio<unknown>["children"]> extends Cheerio<
  infer E
>
  ? E
  : never;

type CheerioNode = ReturnType<Cheerio<unknown>["contents"]> extends Cheerio<
  infer E
>
  ? E
  : never;

// ---------------------------------------------------------------------------
// Options / caps.
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Absolute URL this HTML came from. */
  url: string;
  /** Site origin, for same-origin link filtering. */
  origin: string;
  httpStatus: number;
  contentType?: string;
  byteSize: number;
}

const MAX_OG_ENTRIES = 20;
const OG_VALUE_MAX = 300;
const MAX_JSONLD_BLOCKS = 5;
const MAX_JSONLD_CHARS = 20000;
const MAX_HEADINGS = 60;
const HEADING_TEXT_MAX = 200;
const MAX_NAV_LINKS = 30;
const MAX_LINKS = 200;
const MAX_SECTIONS = 12;
const SECTION_TEXT_MAX = 600;
const MAX_CONTACT_ENTRIES = 10;
const MAX_GROUPS = 12;
const MAX_GROUP_SAMPLE_LEN = 200;
const MAX_FIELD_SAMPLE_LEN = 200;
const MIN_SECTION_TEXT_LEN = 120;
const LOW_INFO_TEXT_LEN = 400;
const LOW_INFO_HEADING_COUNT = 3;
const MAX_FLAT_ELEMENTS = 20000;
const MAX_CHILDREN_PER_CONTAINER = 2000;
const MIN_GROUP_MEMBERS = 3;

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function resolveUrl(href: string, base: string): URL | undefined {
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

function isSkippableHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return (
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:") ||
    trimmed.startsWith("javascript:")
  );
}

const GENERATED_CLASS_RE = /^(css-|sc-|framer-|jsx-|w-node-)/;

function isGeneratedClass(cls: string): boolean {
  if (cls.length === 0) return true;
  if (GENERATED_CLASS_RE.test(cls)) return true;
  if (cls.length > 24) return true;
  const digitCount = (cls.match(/\d/g) ?? []).length;
  if (digitCount >= 4) return true;
  if (/^[a-f0-9]{6,}$/i.test(cls)) return true;
  return false;
}

/** Stable, human-readable classes on an element — the auto-generated ones
 * (hashes, css-in-js, Framer/Webflow internals) are filtered out. */
function readableClasses(classAttr: string | undefined): string[] {
  if (!classAttr) return [];
  const classes = classAttr.split(/\s+/).filter((c) => c.length > 0);
  return [...new Set(classes.filter((c) => !isGeneratedClass(c)))];
}

function cssIdentEscape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

const SOCIAL_DOMAINS: Array<[string, string[]]> = [
  ["github", ["github.com"]],
  ["linkedin", ["linkedin.com"]],
  ["twitter", ["twitter.com"]],
  ["x", ["x.com"]],
  ["dribbble", ["dribbble.com"]],
  ["behance", ["behance.net"]],
  ["instagram", ["instagram.com"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["medium", ["medium.com"]],
  ["gitlab", ["gitlab.com"]],
  ["figma", ["figma.com"]],
];

function matchSocialPlatform(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  for (const [platform, domains] of SOCIAL_DOMAINS) {
    for (const domain of domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return platform;
    }
  }
  return undefined;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// ---------------------------------------------------------------------------
// DOM cleanup.
// ---------------------------------------------------------------------------

function removeComments($: CheerioAPI): void {
  const stripFrom = (nodes: Cheerio<CheerioNode>) => {
    nodes.each((_i, node) => {
      if (node.type === "comment") {
        $(node).remove();
      }
    });
  };
  stripFrom($.root().contents());
  stripFrom($("*").contents());
}

function removeNoise($: CheerioAPI): void {
  $("script, style, noscript, template, svg").remove();
  removeComments($);
}

// ---------------------------------------------------------------------------
// Head metadata.
// ---------------------------------------------------------------------------

function collectOpenGraph($: CheerioAPI): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;

  const addMetas = (selector: string, prefixes: string[]) => {
    $(selector).each((_i, el) => {
      if (count >= MAX_OG_ENTRIES) return;
      const key = $(el).attr("property") ?? $(el).attr("name");
      if (!key) return;
      let shortKey = key;
      for (const prefix of prefixes) {
        if (key.startsWith(prefix)) {
          shortKey = key.slice(prefix.length);
          break;
        }
      }
      if (!shortKey || shortKey in result) return;
      const content = $(el).attr("content");
      if (!content) return;
      const trimmed = content.trim();
      if (!trimmed) return;
      result[shortKey] = truncate(trimmed, OG_VALUE_MAX);
      count++;
    });
  };

  addMetas("meta[property^='og:']", ["og:"]);
  addMetas("meta[name^='twitter:']", ["twitter:"]);

  return result;
}

function collectJsonLd($: CheerioAPI): unknown[] {
  const blocks: unknown[] = [];
  $("script[type='application/ld+json']").each((_i, el) => {
    if (blocks.length >= MAX_JSONLD_BLOCKS) return;
    const raw = $(el).text();
    if (!raw || raw.length > MAX_JSONLD_CHARS) return;
    try {
      blocks.push(JSON.parse(raw) as unknown);
    } catch {
      // Malformed JSON-LD is common in the wild; skip it rather than fail
      // the whole extraction.
    }
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Headings, nav, links, sections, contact.
// ---------------------------------------------------------------------------

function collectHeadings($: CheerioAPI): Heading[] {
  const flat = $.root().find("*").toArray();
  const headings: Heading[] = [];
  for (const el of flat) {
    const tag = el.tagName.toLowerCase();
    const match = /^h([1-4])$/.exec(tag);
    if (!match) continue;
    const text = collapse($(el).text());
    if (!text) continue;
    headings.push({ level: Number(match[1]), text: truncate(text, HEADING_TEXT_MAX) });
    if (headings.length >= MAX_HEADINGS) break;
  }
  return headings;
}

function collectNav($: CheerioAPI, options: ExtractOptions): NavLink[] {
  const anchors = $(
    "nav a[href], [role='navigation'] a[href], header a[href]",
  );
  const seen = new Set<string>();
  const result: NavLink[] = [];
  anchors.each((_i, el) => {
    if (result.length >= MAX_NAV_LINKS) return;
    const href = $(el).attr("href");
    if (!href || isSkippableHref(href)) return;
    const resolved = resolveUrl(href, options.url);
    if (!resolved) return;
    resolved.hash = "";
    const finalHref = resolved.toString();
    if (seen.has(finalHref)) return;
    seen.add(finalHref);

    const label = collapse($(el).text());
    const navLink: NavLink = { label, href: finalHref };
    if (resolved.origin === options.origin) {
      navLink.pathname = resolved.pathname;
    }
    result.push(navLink);
  });
  return result;
}

function collectLinks($: CheerioAPI, options: ExtractOptions): NavLink[] {
  const anchors = $("a[href]");
  const seen = new Set<string>();
  const result: NavLink[] = [];
  anchors.each((_i, el) => {
    if (result.length >= MAX_LINKS) return;
    const href = $(el).attr("href");
    if (!href || isSkippableHref(href)) return;
    const resolved = resolveUrl(href, options.url);
    if (!resolved || resolved.origin !== options.origin) return;
    resolved.hash = "";
    const finalHref = resolved.toString();
    if (seen.has(finalHref)) return;
    seen.add(finalHref);

    result.push({
      label: collapse($(el).text()),
      href: finalHref,
      pathname: resolved.pathname,
    });
  });
  return result;
}

function buildDisplaySelector($: CheerioAPI, el: CheerioElement): string {
  const tag = el.tagName.toLowerCase();
  const id = $(el).attr("id");
  if (id) return `#${cssIdentEscape(id)}`;

  const classes = readableClasses($(el).attr("class"));
  if (classes.length > 0) return `${tag}.${cssIdentEscape(classes[0])}`;

  const parent = el.parent;
  if (parent && parent.type === "tag") {
    const parentId = $(parent).attr("id");
    if (parentId) return `#${cssIdentEscape(parentId)} > ${tag}`;
    const parentClasses = readableClasses($(parent).attr("class"));
    if (parentClasses.length > 0) {
      return `.${cssIdentEscape(parentClasses[0])} > ${tag}`;
    }
    return `${parent.tagName.toLowerCase()} > ${tag}`;
  }

  return tag;
}

function collectSections($: CheerioAPI): PageSection[] {
  const flat = $.root().find("*").toArray();
  const orderIndex = new Map<CheerioElement, number>();
  flat.forEach((el, i) => orderIndex.set(el, i));

  const headingRefs = flat
    .filter((el) => /^h[1-3]$/i.test(el.tagName))
    .map((el) => ({
      index: orderIndex.get(el) ?? -1,
      text: collapse($(el).text()),
    }))
    .filter((h) => h.text.length > 0);

  const nearestHeadingFor = (el: CheerioElement): string | undefined => {
    const contained = $(el).find("h1, h2, h3").first();
    if (contained.length > 0) {
      const text = collapse(contained.text());
      if (text) return text;
    }
    const myIndex = orderIndex.get(el) ?? -1;
    let best: { index: number; text: string } | undefined;
    for (const h of headingRefs) {
      if (h.index < myIndex && (!best || h.index > best.index)) best = h;
    }
    return best?.text;
  };

  const candidates = $("section, article, main > div").toArray();
  const scored: Array<{ section: PageSection; len: number }> = [];
  for (const el of candidates) {
    const text = collapse($(el).text());
    if (text.length < MIN_SECTION_TEXT_LEN) continue;
    scored.push({
      section: {
        heading: nearestHeadingFor(el),
        selector: buildDisplaySelector($, el),
        text: truncate(text, SECTION_TEXT_MAX),
      },
      len: text.length,
    });
  }
  scored.sort((a, b) => b.len - a.len);
  return scored.slice(0, MAX_SECTIONS).map((s) => s.section);
}

function collectContact($: CheerioAPI, options: ExtractOptions): ContactSignals {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials: Array<{ platform: string; url: string }> = [];
  const seenSocialKeys = new Set<string>();

  $("a[href^='mailto:']").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const addr = href.slice("mailto:".length).split("?")[0]?.trim();
    if (addr) emails.add(addr.toLowerCase());
  });

  const bodyText = $("body").text();
  const emailMatches = bodyText.match(EMAIL_RE) ?? [];
  for (const match of emailMatches) {
    emails.add(match.toLowerCase());
  }

  $("a[href^='tel:']").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const num = href.slice("tel:".length).trim();
    if (num) phones.add(num);
  });

  $("a[href]").each((_i, el) => {
    if (socials.length >= MAX_CONTACT_ENTRIES) return;
    const href = $(el).attr("href");
    if (!href) return;
    const resolved = resolveUrl(href, options.url);
    if (!resolved) return;
    const platform = matchSocialPlatform(resolved.hostname);
    if (!platform) return;
    const url = resolved.toString();
    const key = `${platform}:${url}`;
    if (seenSocialKeys.has(key)) return;
    seenSocialKeys.add(key);
    socials.push({ platform, url });
  });

  return {
    emails: [...emails].slice(0, MAX_CONTACT_ENTRIES),
    phones: [...phones].slice(0, MAX_CONTACT_ENTRIES),
    socials: socials.slice(0, MAX_CONTACT_ENTRIES),
  };
}

// ---------------------------------------------------------------------------
// Repeated-structure detection.
// ---------------------------------------------------------------------------

interface CandidateGroup {
  container: CheerioElement;
  members: CheerioElement[];
  readableClassesShared: string[];
}

function findCandidateGroups($: CheerioAPI): CandidateGroup[] {
  const flat = $.root().find("*").toArray().slice(0, MAX_FLAT_ELEMENTS);
  const candidates: CandidateGroup[] = [];

  for (const container of flat) {
    const children = $(container).children().toArray();
    if (children.length < MIN_GROUP_MEMBERS) continue;
    if (children.length > MAX_CHILDREN_PER_CONTAINER) continue;

    const bySignature = new Map<string, CheerioElement[]>();
    for (const child of children) {
      const text = collapse($(child).text());
      if (text.length === 0) continue;
      const tag = child.tagName.toLowerCase();
      const classes = readableClasses($(child).attr("class")).sort();
      const signature = `${tag}|${classes.join(".")}`;
      const arr = bySignature.get(signature) ?? [];
      arr.push(child);
      bySignature.set(signature, arr);
    }

    for (const [signature, members] of bySignature) {
      if (members.length < MIN_GROUP_MEMBERS) continue;
      const classPart = signature.split("|")[1] ?? "";
      const readableClassesShared = classPart.length > 0 ? classPart.split(".") : [];
      candidates.push({ container, members, readableClassesShared });
    }
  }

  return candidates;
}

function sharedDataAttribute(
  members: CheerioElement[],
): string | undefined {
  if (members.length === 0) return undefined;
  const firstAttribs = members[0].attribs;
  const dataKeys = Object.keys(firstAttribs).filter((k) => k.startsWith("data-"));
  for (const key of dataKeys) {
    const allHave = members.every((m) =>
      Object.prototype.hasOwnProperty.call(m.attribs, key),
    );
    if (allHave) return key;
  }
  return undefined;
}

function stableSelfSelector($: CheerioAPI, el: CheerioElement): string {
  const id = $(el).attr("id");
  if (id) return `#${cssIdentEscape(id)}`;
  const classes = readableClasses($(el).attr("class"));
  if (classes.length > 0) return `.${cssIdentEscape(classes[0])}`;
  return el.tagName.toLowerCase();
}

function buildItemSelector(
  $: CheerioAPI,
  container: CheerioElement,
  members: CheerioElement[],
  readableClassesShared: string[],
): string | undefined {
  const itemTag = members[0].tagName.toLowerCase();
  const candidates: string[] = [];

  if (readableClassesShared.length > 0) {
    candidates.push(`.${cssIdentEscape(readableClassesShared[0])}`);
  }

  const sharedData = sharedDataAttribute(members);
  if (sharedData) {
    candidates.push(`[${sharedData}]`);
  }

  candidates.push(`${stableSelfSelector($, container)} > ${itemTag}`);

  for (const candidate of candidates) {
    let matchedCount: number;
    try {
      matchedCount = $(candidate).length;
    } catch {
      continue;
    }
    if (matchedCount === members.length) return candidate;
  }
  return undefined;
}

type FieldSource = RepeatedField["source"];

interface FieldSpec {
  role: string;
  parts: string[];
  source: FieldSource;
  attribute?: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { role: "title", parts: ["h1", "h2", "h3", "h4", "h5", "h6"], source: "text" },
  { role: "description", parts: ["p"], source: "text" },
  { role: "link", parts: ["a[href]"], source: "href" },
  { role: "image", parts: ["img[src]"], source: "src" },
  {
    role: "date",
    parts: ["time[datetime]"],
    source: "attr",
    attribute: "datetime",
  },
  { role: "tag", parts: [".tag", ".category"], source: "text" },
];

function detectFieldPart(
  $: CheerioAPI,
  members: CheerioElement[],
  parts: string[],
): string | undefined {
  let best: { part: string; count: number } | undefined;
  for (const part of parts) {
    let count = 0;
    for (const member of members) {
      if ($(member).find(part).first().length > 0) count++;
    }
    if (count > 0 && (!best || count > best.count)) best = { part, count };
  }
  return best?.part;
}

function readFieldValue(
  el: Cheerio<CheerioElement>,
  source: FieldSource,
  attribute?: string,
): string {
  if (source === "text") return collapse(el.text());
  if (source === "href") return el.attr("href") ?? "";
  if (source === "src") return el.attr("src") ?? "";
  if (source === "attr" && attribute) return el.attr(attribute) ?? "";
  return "";
}

function buildField(
  $: CheerioAPI,
  members: CheerioElement[],
  spec: FieldSpec,
): RepeatedField | undefined {
  const part = detectFieldPart($, members, spec.parts);
  if (!part) return undefined;

  let coverageCount = 0;
  const samples: string[] = [];
  for (const member of members) {
    const found = $(member).find(part).first();
    if (found.length === 0) continue;
    const value = readFieldValue(found, spec.source, spec.attribute);
    if (value.trim().length > 0) {
      coverageCount++;
      if (samples.length < 3) samples.push(truncate(value, MAX_FIELD_SAMPLE_LEN));
    }
  }
  const coverage = members.length > 0 ? coverageCount / members.length : 0;
  if (coverage < 0.5) return undefined;

  return {
    selector: part,
    source: spec.source,
    attribute: spec.attribute,
    coverage,
    samples,
  };
}

function extractFields(
  $: CheerioAPI,
  members: CheerioElement[],
): Record<string, RepeatedField> {
  const fields: Record<string, RepeatedField> = {};
  for (const spec of FIELD_SPECS) {
    const field = buildField($, members, spec);
    if (field) fields[spec.role] = field;
  }
  return fields;
}

function scoreGroup(
  memberCount: number,
  fields: Record<string, RepeatedField>,
  usedReadableClass: boolean,
): number {
  const countScore = Math.min(1, memberCount / 10);
  const coverages = Object.values(fields).map((f) => f.coverage);
  const avgCoverage =
    coverages.length > 0
      ? coverages.reduce((a, b) => a + b, 0) / coverages.length
      : 0;
  const hasTitleAndLink = Boolean(fields.title) && Boolean(fields.link);
  const score =
    countScore * 0.35 +
    avgCoverage * 0.3 +
    (hasTitleAndLink ? 0.25 : 0) +
    (usedReadableClass ? 0.1 : 0);
  return Math.round(score * 1000) / 1000;
}

function buildRepeatedGroup(
  $: CheerioAPI,
  candidate: CandidateGroup,
): RepeatedGroup | undefined {
  const itemSelector = buildItemSelector(
    $,
    candidate.container,
    candidate.members,
    candidate.readableClassesShared,
  );
  if (!itemSelector) return undefined;

  const containerSelector = stableSelfSelector($, candidate.container);
  const fields = extractFields($, candidate.members);
  const samples = candidate.members
    .slice(0, 3)
    .map((m) => truncate(collapse($(m).text()), MAX_GROUP_SAMPLE_LEN));
  const score = scoreGroup(
    candidate.members.length,
    fields,
    candidate.readableClassesShared.length > 0,
  );

  return {
    id: "",
    itemSelector,
    containerSelector,
    count: candidate.members.length,
    fields,
    samples,
    score,
  };
}

function detectRepeatedGroups($: CheerioAPI): RepeatedGroup[] {
  const candidates = findCandidateGroups($);

  const built: RepeatedGroup[] = [];
  const seenSelectors = new Set<string>();
  for (const candidate of candidates) {
    const group = buildRepeatedGroup($, candidate);
    if (!group) continue;
    if (seenSelectors.has(group.itemSelector)) continue;
    seenSelectors.add(group.itemSelector);
    built.push(group);
  }

  built.sort((a, b) => b.score - a.score);
  return built.slice(0, MAX_GROUPS).map((group, i) => ({
    ...group,
    id: `g${i + 1}`,
  }));
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export function extractPage(html: string, options: ExtractOptions): PageExtraction {
  const $ = load(html);

  // Signals that only exist before we strip the DOM: the platform
  // fingerprint (Next.js's `#__NEXT_DATA__` script, Framer/Wix/Webflow/
  // Squarespace markers) and JSON-LD blocks (which live inside `<script>`
  // tags we're about to remove).
  const platform = fingerprintPlatform(html, $, options.url);
  const jsonLd = collectJsonLd($);

  const titleRaw = $("title").first().text();
  const title = titleRaw ? collapse(titleRaw) : undefined;
  const metaDescription =
    $("meta[name='description']").attr("content")?.trim() || undefined;
  const canonicalHref = $("link[rel='canonical']").attr("href");
  const canonical = canonicalHref
    ? resolveUrl(canonicalHref, options.url)?.toString()
    : undefined;
  const openGraph = collectOpenGraph($);

  removeNoise($);

  const headings = collectHeadings($);
  const nav = collectNav($, options);
  const links = collectLinks($, options);
  const sections = collectSections($);
  const contact = collectContact($, options);
  const repeatedGroups = detectRepeatedGroups($);

  const textLength = collapse($("body").text()).length;
  const lowInformation =
    textLength < LOW_INFO_TEXT_LEN && headings.length < LOW_INFO_HEADING_COUNT;

  let pathname = "/";
  try {
    pathname = new URL(options.url).pathname || "/";
  } catch {
    pathname = "/";
  }

  const routePattern = inferRoutePattern(pathname);
  const pageType = inferPageType(pathname, {
    title,
    headings: headings.map((h) => h.text),
  });

  const page: PageExtraction = {
    url: options.url,
    pathname,
    routePattern,
    pageType,
    title,
    metaDescription,
    canonical,
    openGraph,
    jsonLd,
    platform,
    headings,
    nav,
    links,
    sections,
    repeatedGroups,
    contact,
    textLength,
    lowInformation,
    httpStatus: options.httpStatus,
    contentType: options.contentType,
    byteSize: options.byteSize,
  };

  return page;
}

function mergeNavigation(pages: PageExtraction[]): NavLink[] {
  const byHref = new Map<string, NavLink>();
  for (const page of pages) {
    for (const link of page.nav) {
      const existing = byHref.get(link.href);
      if (!existing || (!existing.pathname && link.pathname)) {
        byHref.set(link.href, link);
      }
    }
  }
  return [...byHref.values()].slice(0, MAX_NAV_LINKS);
}

export function buildRepresentation(
  pages: PageExtraction[],
  input: {
    origin: string;
    entryUrl: string;
    failures: Array<{ url: string; reason: string }>;
  },
): ScanRepresentation {
  const platform = mergeFingerprints(pages.map((page) => page.platform));

  const navigation = mergeNavigation(pages);
  const routePatterns = summarizeRoutePatterns(pages.map((p) => p.pathname));
  const lowInfoCount = pages.filter((p) => p.lowInformation).length;
  const lowInformation = pages.length > 0 && lowInfoCount > pages.length / 2;

  return {
    origin: input.origin,
    entryUrl: input.entryUrl,
    platform,
    pages,
    routePatterns,
    navigation,
    failures: input.failures,
    lowInformation,
  };
}
