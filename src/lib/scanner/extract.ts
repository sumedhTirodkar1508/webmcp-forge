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
const MIN_GROUP_MEMBERS = 2;

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
    const id = $(el).attr("id");
    const selector = id
      ? `#${cssIdentEscape(id)}`
      : $(tag).length === 1
        ? tag
        : undefined;
    headings.push({
      level: Number(match[1]),
      text: truncate(text, HEADING_TEXT_MAX),
      ...(selector ? { selector } : {}),
    });
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
    const finalHref = resolved.toString();
    if (seen.has(finalHref)) return;
    seen.add(finalHref);

    const label = collapse($(el).text());
    const navLink: NavLink = { label, href: finalHref };
    if (resolved.origin === options.origin) {
      navLink.pathname = resolved.pathname;
      navLink.path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
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
  const scored: Array<{ section: PageSection; importance: number }> = [];
  for (const el of candidates) {
    const text = collapse($(el).text());
    if (text.length < MIN_SECTION_TEXT_LEN) continue;
    const id = $(el).attr("id") || undefined;
    const ariaLabel = $(el).attr("aria-label")?.trim() || undefined;
    const tag = el.tagName.toLowerCase();
    scored.push({
      section: {
        heading: nearestHeadingFor(el),
        selector: buildExactSelector($, el),
        text: truncate(text, SECTION_TEXT_MAX),
        ...(id ? { id } : {}),
        ...(ariaLabel ? { ariaLabel } : {}),
        landmark: tag,
        documentOrder: orderIndex.get(el) ?? 0,
      },
      importance:
        (tag === "section" ? 4000 : tag === "article" ? 2000 : 1000) +
        (id ? 1500 : 0) +
        (ariaLabel ? 500 : 0) +
        Math.min(text.length, 1000),
    });
  }
  return scored
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_SECTIONS)
    .sort(
      (a, b) =>
        (a.section.documentOrder ?? 0) - (b.section.documentOrder ?? 0),
    )
    .map((s) => s.section);
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
      // Component frameworks frequently hash every class name. The useful
      // invariant is the sibling topology: like-tagged children of one
      // container. Field coverage below confirms that they share a useful
      // internal shape before a group is accepted.
      const signature = tag;
      const arr = bySignature.get(signature) ?? [];
      arr.push(child);
      bySignature.set(signature, arr);
    }

    for (const [signature, members] of bySignature) {
      if (members.length < MIN_GROUP_MEMBERS) continue;
      // Page-level sections are layout, not a content collection. Their inner
      // lists are considered independently and carry much stronger context.
      if (
        (container.tagName.toLowerCase() === "main" ||
          container.tagName.toLowerCase() === "body") &&
        signature === "section"
      ) {
        continue;
      }
      // Two-column wrappers inside a single card/timeline item describe
      // layout, not another collection. The surrounding sibling list is the
      // meaningful repeated structure.
      if (
        (container.tagName.toLowerCase() === "article" ||
          container.tagName.toLowerCase() === "li") &&
        (signature === "div" || signature === "span")
      ) {
        continue;
      }
      const readableClassesShared = members.reduce<string[]>((shared, member, index) => {
        const classes = readableClasses($(member).attr("class"));
        return index === 0 ? classes : shared.filter((name) => classes.includes(name));
      }, []);
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
  const dataKeys = Object.keys(firstAttribs).filter(
    (k) =>
      k.startsWith("data-") &&
      !/^data-(framer|react|next|w-|test)/i.test(k),
  );
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

function sameElements(actual: CheerioElement[], expected: CheerioElement[]): boolean {
  return actual.length === expected.length && actual.every((el, i) => el === expected[i]);
}

function selectorMatchesExactly(
  $: CheerioAPI,
  selector: string,
  expected: CheerioElement[],
): boolean {
  try {
    const actual = $(selector)
      .toArray()
      .filter((node): node is CheerioElement => node.type === "tag");
    return sameElements(actual, expected);
  } catch {
    return false;
  }
}

function stableAnchorSelector(
  $: CheerioAPI,
  el: CheerioElement,
): string | undefined {
  const id = $(el).attr("id");
  if (id) return `#${cssIdentEscape(id)}`;

  const ariaLabel = $(el).attr("aria-label")?.trim();
  if (ariaLabel && /^[\w .:/-]{1,120}$/.test(ariaLabel)) {
    const candidate = `[aria-label="${ariaLabel}"]`;
    if ($(candidate).length === 1) return candidate;
  }

  const classes = readableClasses($(el).attr("class"));
  for (const className of classes) {
    const candidate = `.${cssIdentEscape(className)}`;
    if ($(candidate).length === 1) return candidate;
  }
  return undefined;
}

function nearestStableAnchor(
  $: CheerioAPI,
  el: CheerioElement,
): { element: CheerioElement; selector: string } {
  let current: CheerioElement | undefined = el;
  while (current) {
    const selector = stableAnchorSelector($, current);
    if (selector) return { element: current, selector };
    const parent: CheerioNode | null = current.parent;
    current = parent && parent.type === "tag" ? parent : undefined;
  }
  const bodyNode = $("body").get(0);
  const body = bodyNode?.type === "tag" ? bodyNode : undefined;
  return body ? { element: body, selector: "body" } : { element: el, selector: stableSelfSelector($, el) };
}

function structuralPathFrom(
  $: CheerioAPI,
  anchor: CheerioElement,
  target: CheerioElement,
): string | undefined {
  if (anchor === target) return "";
  const parts: string[] = [];
  let current: CheerioElement | undefined = target;
  while (current && current !== anchor) {
    const tag = current.tagName.toLowerCase();
    const parent: CheerioNode | null = current.parent;
    if (!parent || parent.type !== "tag") return undefined;
    const sameTagSiblings = $(parent).children(tag).toArray();
    const index = sameTagSiblings.indexOf(current);
    parts.unshift(
      sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag,
    );
    current = parent;
  }
  return current === anchor ? parts.join(" > ") : undefined;
}

function buildExactSelector($: CheerioAPI, el: CheerioElement): string {
  const own = stableAnchorSelector($, el);
  if (own) return own;
  const anchor = nearestStableAnchor($, el);
  const path = structuralPathFrom($, anchor.element, el);
  return path ? `${anchor.selector} > ${path}` : stableSelfSelector($, el);
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
    candidates.push(`${buildExactSelector($, container)} > [${sharedData}]`);
  }

  const anchor = nearestStableAnchor($, container);
  const containerPath = structuralPathFrom($, anchor.element, container);
  candidates.push(`${buildExactSelector($, container)} > ${itemTag}`);
  candidates.push(`${anchor.selector} ${container.tagName.toLowerCase()} > ${itemTag}`);
  if (containerPath) {
    candidates.push(`${anchor.selector} > ${containerPath} > ${itemTag}`);
  }

  for (const candidate of [...new Set(candidates)]) {
    if (selectorMatchesExactly($, candidate, members)) return candidate;
  }
  return undefined;
}

type FieldSource = RepeatedField["source"];

interface FieldSpec {
  role: string;
  parts: string[];
  source: FieldSource;
  attribute?: string;
  hints: string[];
}

const FIELD_SPECS: FieldSpec[] = [
  {
    role: "title",
    parts: ["h1", "h2", "h3", "h4", "h5", "h6"],
    source: "text",
    hints: ["heading", "primary text"],
  },
  { role: "description", parts: ["p"], source: "text", hints: ["prose"] },
  { role: "link", parts: ["a[href]"], source: "href", hints: ["link"] },
  { role: "image", parts: ["img[src]"], source: "src", hints: ["image"] },
  {
    role: "date",
    parts: ["time[datetime]"],
    source: "attr",
    attribute: "datetime",
    hints: ["date", "machine-readable time"],
  },
  {
    role: "dateText",
    parts: ["time"],
    source: "text",
    hints: ["date", "visible time"],
  },
  { role: "tag", parts: [".tag", ".category"], source: "text", hints: ["tag"] },
  {
    role: "nestedList",
    parts: ["ul", "ol"],
    source: "text",
    hints: ["nested list", "multiple values"],
  },
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
  if (source === "text") {
    const tag = el.get(0)?.tagName?.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      return el
        .children()
        .toArray()
        .map((child) => collapse(el._make(child).text()))
        .filter(Boolean)
        .join(", ");
    }
    return collapse(el.text());
  }
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
    hints: spec.hints,
  };
}

const GENERIC_FIELD_SPECS: Array<Omit<FieldSpec, "role">> = [
  { parts: ["h1"], source: "text", hints: ["heading", "level 1"] },
  { parts: ["h2"], source: "text", hints: ["heading", "level 2"] },
  { parts: ["h3"], source: "text", hints: ["heading", "level 3"] },
  { parts: ["h4"], source: "text", hints: ["heading", "level 4"] },
  { parts: ["p:nth-of-type(1)"], source: "text", hints: ["prose", "first paragraph"] },
  { parts: ["p:nth-of-type(2)"], source: "text", hints: ["prose", "second paragraph"] },
  { parts: ["p:nth-of-type(3)"], source: "text", hints: ["prose", "third paragraph"] },
  { parts: ["span:nth-of-type(1)"], source: "text", hints: ["inline text", "first value"] },
  { parts: ["span:nth-of-type(2)"], source: "text", hints: ["inline text", "second value"] },
  { parts: ["span:nth-of-type(3)"], source: "text", hints: ["inline text", "third value"] },
  { parts: ["time"], source: "text", hints: ["date", "visible time"] },
  {
    parts: ["time[datetime]"],
    source: "attr",
    attribute: "datetime",
    hints: ["date", "machine-readable time"],
  },
  { parts: ["a[href]"], source: "href", hints: ["link"] },
  { parts: ["img[src]"], source: "src", hints: ["image"] },
  { parts: ["ul"], source: "text", hints: ["nested list", "multiple values"] },
  { parts: ["ol"], source: "text", hints: ["nested list", "multiple values"] },
];

function extractFields(
  $: CheerioAPI,
  members: CheerioElement[],
): Record<string, RepeatedField> {
  const fields: Record<string, RepeatedField> = {};
  for (const spec of FIELD_SPECS) {
    const field = buildField($, members, spec);
    if (field) fields[spec.role] = field;
  }
  let genericIndex = 1;
  const seen = new Set(
    Object.values(fields).map(
      (field) => `${field.selector}|${field.source}|${field.attribute ?? ""}`,
    ),
  );
  for (const spec of GENERIC_FIELD_SPECS) {
    const field = buildField($, members, { ...spec, role: "candidate" });
    if (!field) continue;
    const signature = `${field.selector}|${field.source}|${field.attribute ?? ""}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    fields[`f${genericIndex++}`] = field;
  }

  if (Object.keys(fields).length === 0 && members.every((member) => $(member).children().length === 0)) {
    const samples = members
      .slice(0, 3)
      .map((member) => truncate(collapse($(member).text()), MAX_FIELD_SAMPLE_LEN));
    if (samples.some(Boolean)) {
      fields.f1 = {
        selector: "",
        source: "text",
        coverage: 1,
        samples,
        hints: ["item text", "leaf value"],
      };
    }
  }
  return fields;
}

function scoreGroup(
  memberCount: number,
  fields: Record<string, RepeatedField>,
  usedReadableClass: boolean,
  hasStableSection: boolean,
  itemTag: string,
): number {
  const countScore = Math.min(1, memberCount / 10);
  const coverages = Object.values(fields).map((f) => f.coverage);
  const avgCoverage =
    coverages.length > 0
      ? coverages.reduce((a, b) => a + b, 0) / coverages.length
      : 0;
  const hasTitleAndLink = Boolean(fields.title) && Boolean(fields.link);
  const score =
    countScore * 0.15 +
    avgCoverage * 0.15 +
    (fields.title ? 0.18 : 0) +
    (fields.description ? 0.1 : 0) +
    (fields.link ? 0.1 : 0) +
    (fields.image ? 0.06 : 0) +
    (fields.date ? 0.1 : 0) +
    (fields.dateText ? 0.1 : 0) +
    (fields.nestedList ? 0.12 : 0) +
    (hasTitleAndLink ? 0.08 : 0) +
    (hasStableSection ? 0.08 : 0) +
    (itemTag === "li" || itemTag === "article" ? 0.05 : 0) +
    (usedReadableClass ? 0.03 : 0);
  return Math.round(score * 1000) / 1000;
}

function groupContext($: CheerioAPI, container: CheerioElement) {
  const sectionNode = $(container).closest("section, article, main, [role='region']").get(0);
  if (!sectionNode || sectionNode.type !== "tag") return undefined;
  const section = sectionNode;
  const sectionSelector = buildExactSelector($, section);
  const heading = collapse($(section).find("h1, h2, h3, h4").first().text()) || undefined;
  const sectionId = $(section).attr("id") || undefined;
  const ariaLabel = $(section).attr("aria-label")?.trim() || undefined;
  const documentOrder = $.root().find("*").toArray().indexOf(sectionNode);
  return {
    sectionSelector,
    ...(sectionId ? { sectionId } : {}),
    ...(heading ? { heading: truncate(heading, HEADING_TEXT_MAX) } : {}),
    ...(ariaLabel ? { ariaLabel: truncate(ariaLabel, HEADING_TEXT_MAX) } : {}),
    landmark: section.tagName.toLowerCase(),
    documentOrder,
  };
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

  // A globally scoped structural item selector must be evaluated from the
  // document root. Supplying its container as the query root would make a
  // selector such as `#work > ol > li` match nothing in the browser. A
  // container is useful only with a globally reusable simple item selector.
  const containerSelector = /^[.[]/.test(itemSelector)
    ? buildExactSelector($, candidate.container)
    : undefined;
  const fields = extractFields($, candidate.members);
  if (Object.keys(fields).length === 0) return undefined;
  const samples = candidate.members
    .slice(0, 3)
    .map((m) => truncate(collapse($(m).text()), MAX_GROUP_SAMPLE_LEN));
  const context = groupContext($, candidate.container);
  const score = scoreGroup(
    candidate.members.length,
    fields,
    candidate.readableClassesShared.length > 0,
    Boolean(context?.sectionId || context?.ariaLabel),
    candidate.members[0].tagName.toLowerCase(),
  );

  return {
    id: "",
    itemSelector,
    ...(containerSelector ? { containerSelector } : {}),
    count: candidate.members.length,
    fields,
    samples,
    score,
    ...(context ? { context } : {}),
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
  for (const section of sections) {
    section.repeatedItemCount = repeatedGroups
      .filter((group) => group.context?.sectionSelector === section.selector)
      .reduce((total, group) => total + group.count, 0);
  }

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
