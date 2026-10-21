import { toAppError } from "@/lib/errors";
import { extractPage, buildRepresentation } from "@/lib/scanner/extract";
import { fetchHtml, type FetchedDocument, type FetchLimits } from "@/lib/scanner/fetch";
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
  /**
   * Wall-clock budget for the whole crawl, in milliseconds.
   *
   * Per-request timeouts alone do not bound a crawl: ten slow pages at ten
   * seconds each is a hundred seconds, which outlives a serverless function and
   * leaves no time for interpretation. Once the budget is spent no new page is
   * started, and the scan continues with whatever was gathered — a partial
   * scan is far more useful than a timed-out request.
   */
  budgetMs?: number;
  /** Pages fetched at once. Small on purpose: this is someone's portfolio. */
  concurrency?: number;
  /** Injectable for tests. */
  fetcher?: (url: string, limits: FetchLimits) => Promise<FetchedDocument>;
  /** Injectable for tests. */
  now?: () => number;
}

const DEFAULT_BUDGET_MS = 25_000;
const DEFAULT_CONCURRENCY = 3;

/** Below this much remaining budget, starting another request is pointless. */
const MIN_USEFUL_REQUEST_MS = 1_500;

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
  /** True when the time budget, not the page limit, ended the crawl. */
  budgetExhausted: boolean;
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
  const fetcher = options.fetcher ?? fetchHtml;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 6));

  /** Per-request limits, with the timeout clamped to what the budget allows. */
  const limitsFor = (): FetchLimits => ({
    timeoutMs: Math.max(
      MIN_USEFUL_REQUEST_MS,
      Math.min(options.timeoutMs, deadline - now()),
    ),
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
  });

  // The entry page is fetched first and separately: its final URL, after
  // redirects, defines the origin every other page is measured against. If it
  // fails the whole scan fails, which is correct — there is nothing to show.
  const entryDoc = await fetcher(entryUrl, limitsFor());
  const origin = new URL(entryDoc.finalUrl).origin;

  const pages: PageExtraction[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  const visited = new Set<string>();
  const perPattern = new Map<string, number>();
  let budgetExhausted = false;

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

  /**
   * Takes the next few candidates in priority order, reserving their
   * route-pattern slots up front so a batch cannot exceed the per-pattern cap
   * just because its members are fetched in parallel.
   */
  const takeBatch = (size: number): Candidate[] => {
    const ordered = [...frontier.values()].sort(
      // Highest priority first; ties broken by shorter path, which favours
      // section roots over deep leaves.
      (a, b) => b.priority - a.priority || a.pathname.length - b.pathname.length,
    );
    const batch: Candidate[] = [];
    for (const candidate of ordered) {
      if (batch.length >= size) break;
      frontier.delete(candidate.url);
      const seen = perPattern.get(candidate.routePattern) ?? 0;
      if (seen >= MAX_PER_ROUTE_PATTERN) continue;
      perPattern.set(candidate.routePattern, seen + 1);
      visited.add(candidate.url);
      batch.push(candidate);
    }
    return batch;
  };

  while (pages.length < options.maxPages && frontier.size > 0) {
    if (deadline - now() < MIN_USEFUL_REQUEST_MS) {
      budgetExhausted = true;
      break;
    }

    const batch = takeBatch(Math.min(concurrency, options.maxPages - pages.length));
    if (batch.length === 0) break;

    const settled = await Promise.allSettled(
      batch.map((candidate) => fetcher(candidate.url, limitsFor())),
    );

    // Processed in batch order, so results stay deterministic regardless of
    // which request happened to finish first.
    for (const [index, outcome] of settled.entries()) {
      const candidate = batch[index]!;

      if (outcome.status === "rejected") {
        failures.push({ url: candidate.url, reason: toAppError(outcome.reason).code });
        // The reserved slot was never used; give it back.
        perPattern.set(
          candidate.routePattern,
          Math.max(0, (perPattern.get(candidate.routePattern) ?? 1) - 1),
        );
        continue;
      }

      const doc = outcome.value;
      // A redirect may have landed us somewhere already scanned, or off-site.
      if (doc.finalUrl !== candidate.url && visited.has(doc.finalUrl)) continue;
      if (new URL(doc.finalUrl).origin !== origin) continue;
      visited.add(doc.finalUrl);

      if (pages.length >= options.maxPages) break;

      const page = extractPage(doc.html, {
        url: doc.finalUrl,
        origin,
        httpStatus: doc.status,
        contentType: doc.contentType,
        byteSize: doc.byteSize,
      });

      pages.push(page);
      enqueueFrom(page);
    }

    // A handful of dead links is normal; a wall of them is not.
    if (failures.length > options.maxPages) break;
  }

  return {
    pages,
    failures,
    budgetExhausted,
    representation: buildRepresentation(pages, {
      origin,
      entryUrl: entryDoc.finalUrl,
      failures,
    }),
  };
}
