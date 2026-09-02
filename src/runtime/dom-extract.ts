import type {
  FieldMapping,
  ListMapping,
  SingleMapping,
} from "@/lib/ai/mapping-schema";

/**
 * Live DOM extraction.
 *
 * Every WebMCP tool on an installed portfolio reads the page *at invocation
 * time* through these functions. That is what lets a portfolio owner add an
 * eighth project to their site and have `list_projects` return eight items
 * immediately, with no re-scan, no new configuration and — crucially — no
 * Gemini call. Nothing in this file talks to a network.
 *
 * Everything is bounded: a hostile or merely enormous page cannot make a tool
 * return a megabyte of text or spin forever.
 */

/** Longest single field value we will return. */
const MAX_FIELD_LENGTH = 2000;
/** Most items any one list can yield, before the caller's own limit applies. */
export const MAX_ITEMS = 200;

export interface ExtractedItem {
  /** Stable-ish identity for `get_project` / `focus_project` lookups. */
  index: number;
  id?: string;
  fields: Record<string, string>;
}

/** Collapses whitespace and truncates. Never returns undefined for "". */
export function cleanText(value: string | null | undefined): string {
  if (!value) return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FIELD_LENGTH
    ? `${collapsed.slice(0, MAX_FIELD_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Runs a selector, returning [] rather than throwing on a malformed one.
 *
 * Selectors reach here from stored configuration. They are only ever handed to
 * `querySelectorAll`, never to `innerHTML`, `eval` or a `Function` constructor,
 * so the worst a bad selector can do is match nothing.
 */
export function safeQueryAll(root: ParentNode, selector: string): Element[] {
  if (!selector) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function safeQuery(root: ParentNode, selector: string): Element | null {
  if (!selector) return null;
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/** Resolves a possibly-relative URL against the page, discarding junk. */
function resolveUrl(value: string | null, baseUrl: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Reads one mapped field from an item element. */
export function readField(
  item: Element,
  mapping: FieldMapping,
  baseUrl: string,
): string {
  // An empty selector means "the item element itself".
  const target = mapping.selector === "" ? item : safeQuery(item, mapping.selector);
  if (!target) return "";

  switch (mapping.source) {
    case "text":
      return cleanText(target.textContent);
    case "href":
      return resolveUrl(target.getAttribute("href"), baseUrl);
    case "src":
      return resolveUrl(
        target.getAttribute("src") ?? target.getAttribute("data-src"),
        baseUrl,
      );
    case "attr":
      return mapping.attribute
        ? cleanText(target.getAttribute(mapping.attribute))
        : "";
    default:
      return "";
  }
}

/**
 * Does a stored route pattern apply to the current path?
 *
 * `*` matches everything; `/work/*` matches `/work/anything` but not `/work`
 * itself, so an index page and a detail page can carry different mappings.
 */
export function routeMatches(pattern: string, pathname: string): boolean {
  if (pattern === "*") return true;

  const normalize = (value: string) =>
    value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;

  const patternParts = normalize(pattern).split("/").filter(Boolean);
  const pathParts = normalize(pathname).split("/").filter(Boolean);

  if (patternParts.length === 0) return pathParts.length === 0;
  if (patternParts.length !== pathParts.length) return false;

  return patternParts.every(
    (part, i) => part === "*" || part.toLowerCase() === pathParts[i]!.toLowerCase(),
  );
}

export interface ListExtractionResult {
  items: ExtractedItem[];
  /** How many elements the item selector actually matched. */
  matchCount: number;
  /** What the scan expected, when recorded. */
  expectedCount?: number;
  /** True when the selector matched nothing — the signature of a broken
   *  mapping after a site redesign. */
  broken: boolean;
}

/** Extracts every item of a mapped list from the live document. */
export function extractList(
  doc: Document,
  mapping: ListMapping,
  baseUrl: string,
): ListExtractionResult {
  const root: ParentNode = mapping.containerSelector
    ? (safeQuery(doc, mapping.containerSelector) ?? doc)
    : doc;

  const elements = safeQueryAll(root, mapping.itemSelector);
  const matchCount = elements.length;

  const items: ExtractedItem[] = [];
  for (const [index, element] of elements.slice(0, MAX_ITEMS).entries()) {
    const fields: Record<string, string> = {};
    for (const [role, fieldMapping] of Object.entries(mapping.fields)) {
      const value = readField(element, fieldMapping, baseUrl);
      if (value) fields[role] = value;
    }
    // Skip items that yielded nothing at all — usually spacer or skeleton nodes.
    if (Object.keys(fields).length === 0) continue;

    items.push({
      index,
      id: element.id || element.getAttribute("data-id") || undefined,
      fields,
    });
  }

  return {
    items,
    matchCount,
    expectedCount: mapping.expectedCount,
    broken: matchCount === 0,
  };
}

/** Extracts a handful of single values, e.g. name / headline / bio. */
export function extractSingle(
  doc: Document,
  mapping: SingleMapping,
  baseUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, fieldMapping] of Object.entries(mapping.fields)) {
    const target =
      fieldMapping.selector === ""
        ? doc.body
        : safeQuery(doc, fieldMapping.selector);
    if (!target) continue;
    const value = readField(target, { ...fieldMapping, selector: "" }, baseUrl);
    if (value) out[role] = value;
  }
  return out;
}

/**
 * Finds one item by id, title or index — the identity shape `get_project` and
 * `focus_project` share.
 */
export function findItem(
  items: ExtractedItem[],
  query: { id?: string; title?: string; index?: number },
): ExtractedItem | undefined {
  if (typeof query.index === "number") {
    return items.find((item) => item.index === query.index);
  }
  if (query.id) {
    const wanted = query.id.trim().toLowerCase();
    const byId = items.find((item) => item.id?.toLowerCase() === wanted);
    if (byId) return byId;
  }
  if (query.title) {
    const wanted = query.title.trim().toLowerCase();
    return (
      items.find((item) => item.fields.title?.toLowerCase() === wanted) ??
      items.find((item) => item.fields.title?.toLowerCase().includes(wanted))
    );
  }
  return undefined;
}

/**
 * Deterministic local text search. No model, no network — just scoring against
 * the fields already extracted from the page.
 */
export function searchItems(
  items: ExtractedItem[],
  query: string,
  limit: number,
): ExtractedItem[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, 10);
  if (terms.length === 0) return [];

  const scored = items
    .map((item) => {
      const title = (item.fields.title ?? "").toLowerCase();
      const rest = Object.entries(item.fields)
        .filter(([role]) => role !== "title")
        .map(([, value]) => value.toLowerCase())
        .join(" ");

      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (rest.includes(term)) score += 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index);

  return scored.slice(0, limit).map((entry) => entry.item);
}
