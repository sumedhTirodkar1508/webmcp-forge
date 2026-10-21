import { describe, expect, it } from "vitest";

import { crawlSite } from "@/lib/scanner/crawl";
import type { FetchedDocument } from "@/lib/scanner/fetch";

/**
 * Bounding a crawl in time, not just in pages.
 *
 * Per-request timeouts alone never bounded a scan: ten slow pages at ten
 * seconds each outlives a serverless function and leaves no time for
 * interpretation. The crawl now has a wall-clock budget and fetches a few
 * pages at once, and a slow site yields a partial scan instead of a timeout.
 */

const ORIGIN = "https://portfolio.example";
const LINKS = ["/about", "/work", "/contact", "/work/a", "/work/b", "/blog", "/cv"];

function html(links: string[] = []): string {
  return `<!doctype html><html><body><nav>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join("")}</nav><main><h1>Page</h1><p>${"Readable text. ".repeat(20)}</p></main></body></html>`;
}

function doc(url: string, body: string): FetchedDocument {
  return {
    finalUrl: url,
    status: 200,
    contentType: "text/html",
    html: body,
    byteSize: body.length,
    redirectChain: [url],
    addresses: ["93.184.216.34"],
  };
}

/** A fake clock that advances only when a "request" completes. */
function harness(perRequestMs: number) {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetched: string[] = [];

  const fetcher = async (url: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    clock += perRequestMs;
    inFlight -= 1;
    fetched.push(url);
    return doc(url, url === `${ORIGIN}/` ? html(LINKS) : html());
  };

  return {
    fetcher,
    now: () => clock,
    fetched,
    maxInFlight: () => maxInFlight,
  };
}

const BASE = { maxBytes: 2_000_000, maxRedirects: 3, timeoutMs: 10_000 };

describe("crawl time budget", () => {
  it("stops starting new pages once the budget is spent, and says so", async () => {
    const h = harness(4_000);

    const result = await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 9_000,
      concurrency: 1,
      fetcher: h.fetcher,
      now: h.now,
    });

    // Entry page plus however many fit, never all eight.
    expect(result.pages.length).toBeLessThan(8);
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.budgetExhausted).toBe(true);
  });

  it("does not report exhaustion when the page limit ends the crawl", async () => {
    const h = harness(10);

    const result = await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 3,
      budgetMs: 60_000,
      fetcher: h.fetcher,
      now: h.now,
    });

    expect(result.pages).toHaveLength(3);
    expect(result.budgetExhausted).toBe(false);
  });

  it("always returns the entry page even with a tiny budget", async () => {
    const h = harness(100);

    const result = await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 1,
      fetcher: h.fetcher,
      now: h.now,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.url).toBe(`${ORIGIN}/`);
  });
});

describe("crawl concurrency", () => {
  it("fetches several pages at once, but never more than the limit", async () => {
    const h = harness(10);

    await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 60_000,
      concurrency: 3,
      fetcher: h.fetcher,
      now: h.now,
    });

    expect(h.maxInFlight()).toBeGreaterThan(1);
    expect(h.maxInFlight()).toBeLessThanOrEqual(3);
  });

  it("caps concurrency even if asked for more, to be polite", async () => {
    const h = harness(10);

    await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 60_000,
      concurrency: 50,
      fetcher: h.fetcher,
      now: h.now,
    });

    expect(h.maxInFlight()).toBeLessThanOrEqual(6);
  });

  it("still respects the per-route cap within a parallel batch", async () => {
    // Five project pages share the route `/work/*`; at most two may be read.
    const fetcher = async (url: string) =>
      doc(
        url,
        url === `${ORIGIN}/`
          ? html(["/work/a", "/work/b", "/work/c", "/work/d", "/work/e"])
          : html(),
      );

    const result = await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 60_000,
      concurrency: 5,
      fetcher,
    });

    const projectPages = result.pages.filter((p) => p.pathname.startsWith("/work/"));
    expect(projectPages.length).toBeLessThanOrEqual(2);
  });

  it("records a failed page without losing the rest of the batch", async () => {
    const fetcher = async (url: string) => {
      if (url.endsWith("/about")) throw new Error("boom");
      return doc(url, url === `${ORIGIN}/` ? html(["/about", "/work", "/contact"]) : html());
    };

    const result = await crawlSite(`${ORIGIN}/`, {
      ...BASE,
      maxPages: 10,
      budgetMs: 60_000,
      concurrency: 3,
      fetcher,
    });

    expect(result.failures.map((f) => f.url)).toContain(`${ORIGIN}/about`);
    expect(result.pages.map((p) => p.pathname)).toEqual(
      expect.arrayContaining(["/", "/work", "/contact"]),
    );
  });

  it("produces the same pages regardless of completion order", async () => {
    const run = async (delays: Record<string, number>) => {
      const fetcher = async (url: string) => {
        await new Promise((r) => setTimeout(r, delays[new URL(url).pathname] ?? 0));
        return doc(url, url === `${ORIGIN}/` ? html(["/about", "/work", "/contact"]) : html());
      };
      const result = await crawlSite(`${ORIGIN}/`, {
        ...BASE,
        maxPages: 10,
        budgetMs: 60_000,
        concurrency: 3,
        fetcher,
      });
      return result.pages.map((p) => p.pathname);
    };

    const fast = await run({ "/about": 1, "/work": 1, "/contact": 1 });
    const scrambled = await run({ "/about": 15, "/work": 1, "/contact": 8 });
    expect(scrambled).toEqual(fast);
  });
});
