import { toAppError } from "@/lib/errors";
import { extractPage, buildRepresentation } from "@/lib/scanner/extract";
import { fetchHtml, type FetchLimits } from "@/lib/scanner/fetch";
import { inferPageType, inferRoutePattern } from "@/lib/scanner/routes";
import type { PageExtraction, PageTypeId, ScanRepresentation } from "@/lib/scanner/types";
import { assertSafeUrlSyntax, normalizeUrl } from "@/lib/scanner/url-safety";

/**
 * Bounded, same-origin crawl.
 *
 * Portfolios are small and shallow, so this is deliberately not a general web
 * crawler. It fetches the entry page, then walks a *prioritised* frontier —
 * about / work / contact before anything else, and only a couple of
 * representative pages per repeated route shape. That keeps a scan to a handful
 * of requests while still seeing every kind of page the configuration needs to
 * cover.
 */

export interface CrawlOptions extends FetchLimits {
  maxPages: number;
}

/**
 * How interesting a path is. Higher is fetched first. Anything at or below zero
 * is only fetched if there is budget left over.
 */
function priorityFor(pathname: string, pageType: PageTypeId): number {
  switch (pageType) {
    case "HOME":
      return 100;
    case "WORK_INDEX":
      return 90;
    case "ABOUT":
      return 80;
    case "PROJECT_DETAIL":
      return 70;
    case "CONTACT":
      return 60;
    case "EXPERIENCE":
      return 55;
    case "EDUCATION":
      return 50;
    case "BLOG":
      return 10;
    default:
      // Shallower paths are likelier to be real sections than deep leaves.
      return Math.max(1, 30 - pathname.split("/").filter(Boolean).length * 5);
  }
}

/** Per-route-shape cap, so 40 project pages do not consume the whole budget. */
const MAX_PER_ROUTE_PATTERN = 2;

interface Candidate {
  url: string;
  pathname: string;
  routePattern: string;
  pageType: PageTypeId;
  priority: number;
}

function toCandidate(url: URL): Candidate {
  const pathname = url.pathname || "/";
  const pageType = inferPageType(pathname);
  return {
    url: url.toString(),
    pathname,
    routePattern: inferRoutePattern(pathname),
    pageType,
    priority: priorityFor(pathname, pageType),
  };
}

/** Same-origin, http(s), syntactically safe, and not an asset download. */
function acceptableLink(href: string, origin: string): URL | null {
  const normalized = normalizeUrl(href);
  if (!normalized) return null;
  if (normalized.origin !== origin) return null;
  if (!assertSafeUrlSyntax(normalized.toString()).ok) return null;
  if (/\.(pdf|zip|png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|css|js|json|xml|txt|ico|woff2?)$/i.test(normalized.pathname)) {
    return null;
  }
  return normalized;
}

export interface CrawlResult {
  representation: ScanRepresentation;
  /** Pages we successfully extracted, in fetch order. */
  pages: PageExtraction[];
  failures: Array<{ url: string; reason: string }>;
}

/**
 * Crawls a portfolio starting at `entryUrl`.
 *
 * Throws only when the entry page itself is unusable — after that, individual
 * page failures are collected as warnings and the scan is reported as partial.
 */
export async function crawlSite(
  entryUrl: string,
  options: CrawlOptions,
): Promise<CrawlResult> {
  const limits: FetchLimits = {
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
  };

  // The entry page is fetched first and separately: its final URL, after
  // redirects, defines the origin every other page is measured against.
  const entryDoc = await fetchHtml(entryUrl, limits);
  const origin = new URL(entryDoc.finalUrl).origin;

  const pages: PageExtraction[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  const visited = new Set<string>();
  const perPattern = new Map<string, number>();

  const entryPage = extractPage(entryDoc.html, {
    url: entryDoc.finalUrl,
    origin,
    httpStatus: entryDoc.status,
    contentType: entryDoc.contentType,
    byteSize: entryDoc.byteSize,
  });

  visited.add(entryDoc.finalUrl);
  perPattern.set(entryPage.routePattern, 1);
  pages.push(entryPage);

  const frontier = new Map<string, Candidate>();

  const enqueueFrom = (page: PageExtraction) => {
    for (const link of [...page.nav, ...page.links]) {
      const url = acceptableLink(link.href, origin);
      if (!url) continue;
      const key = url.toString();
      if (visited.has(key) || frontier.has(key)) continue;
      frontier.set(key, toCandidate(url));
    }
  };

  enqueueFrom(entryPage);

  while (pages.length < options.maxPages && frontier.size > 0) {
    // Highest priority first; ties broken by shorter path, which favours
    // section roots over deep leaves.
    const next = [...frontier.values()].sort(
      (a, b) => b.priority - a.priority || a.pathname.length - b.pathname.length,
    )[0]!;
    frontier.delete(next.url);

    const seenForPattern = perPattern.get(next.routePattern) ?? 0;
    if (seenForPattern >= MAX_PER_ROUTE_PATTERN) continue;

    visited.add(next.url);

    try {
      const doc = await fetchHtml(next.url, limits);

      // A redirect may have landed us somewhere already scanned.
      if (visited.has(doc.finalUrl) && doc.finalUrl !== next.url) continue;
      visited.add(doc.finalUrl);
      if (new URL(doc.finalUrl).origin !== origin) continue;

      const page = extractPage(doc.html, {
        url: doc.finalUrl,
        origin,
        httpStatus: doc.status,
        contentType: doc.contentType,
        byteSize: doc.byteSize,
      });

      perPattern.set(page.routePattern, (perPattern.get(page.routePattern) ?? 0) + 1);
      pages.push(page);
      enqueueFrom(page);
    } catch (error) {
      const appError = toAppError(error);
      failures.push({ url: next.url, reason: appError.code });
      // A handful of dead links is normal; a wall of them is not.
      if (failures.length > options.maxPages) break;
    }
  }

  return {
    pages,
    failures,
    representation: buildRepresentation(pages, {
      origin,
      entryUrl: entryDoc.finalUrl,
      failures,
    }),
  };
}
