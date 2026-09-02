import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildRepresentation, extractPage } from "@/lib/scanner/extract";
import type { ExtractOptions } from "@/lib/scanner/extract";
import type { PageExtraction, RepeatedGroup } from "@/lib/scanner/types";

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function extractFixture(
  name: string,
  url: string,
  overrides: Partial<ExtractOptions> = {},
): PageExtraction {
  const html = readFixture(name);
  const origin = new URL(url).origin;
  return extractPage(html, {
    url,
    origin,
    httpStatus: 200,
    contentType: "text/html",
    byteSize: Buffer.byteLength(html, "utf8"),
    ...overrides,
  });
}

function findGroupByCount(
  groups: RepeatedGroup[],
  count: number,
): RepeatedGroup | undefined {
  return groups.find((g) => g.count === count);
}

describe("extractPage — portfolio-home.html (custom, server-rendered)", () => {
  const page = extractFixture("portfolio-home.html", "https://jordanrivera.dev/");

  it("extracts title, meta description, canonical, OG/twitter tags, and JSON-LD", () => {
    expect(page.title).toBe("Jordan Rivera — Product Designer");
    expect(page.metaDescription).toContain("product designer");
    expect(page.canonical).toBe("https://jordanrivera.dev/");
    expect(page.openGraph.title).toBe("Jordan Rivera — Product Designer");
    expect(page.openGraph.description).toContain("Jordan Rivera");
    expect(page.openGraph.image).toBe("https://jordanrivera.dev/og.png");
    expect(page.openGraph.card).toBe("summary_large_image");

    expect(page.jsonLd).toHaveLength(1);
    const person = page.jsonLd[0] as Record<string, unknown>;
    expect(person["@type"]).toBe("Person");
    expect(person.name).toBe("Jordan Rivera");
  });

  it("separates nav links (including external) from same-origin links", () => {
    expect(page.nav.length).toBe(5);
    const githubNav = page.nav.find((l) => l.href.includes("github.com"));
    expect(githubNav).toBeDefined();
    expect(githubNav?.pathname).toBeUndefined();

    const homeNav = page.nav.find((l) => l.href === "https://jordanrivera.dev/");
    expect(homeNav?.pathname).toBe("/");
  });

  it("keeps links same-origin only — external hosts never appear", () => {
    expect(page.links.length).toBeGreaterThan(0);
    expect(page.links.every((l) => l.href.startsWith("https://jordanrivera.dev"))).toBe(
      true,
    );
    expect(page.links.some((l) => l.href.includes("github.com"))).toBe(false);
    expect(page.links.some((l) => l.href.includes("linkedin.com"))).toBe(false);
  });

  it("excludes mailto: and tel: from links but surfaces them in contact", () => {
    expect(page.links.some((l) => l.href.startsWith("mailto:"))).toBe(false);
    expect(page.links.some((l) => l.href.startsWith("tel:"))).toBe(false);

    expect(page.contact.emails).toContain("jordan@jordanrivera.dev");
    expect(page.contact.phones).toContain("+15555550123");
    expect(page.contact.socials.some((s) => s.platform === "github")).toBe(true);
    expect(page.contact.socials.some((s) => s.platform === "linkedin")).toBe(true);
    // Same social appears twice in the markup (nav + contact section) — deduped.
    expect(page.contact.socials.filter((s) => s.platform === "github")).toHaveLength(1);
  });

  it("finds the 4 project cards as a verified repeated group with strong fields", () => {
    const group = findGroupByCount(page.repeatedGroups, 4);
    expect(group).toBeDefined();
    expect(group?.itemSelector).toBe(".project-card");

    expect(group?.fields.title).toBeDefined();
    expect(group?.fields.title?.coverage).toBe(1);
    expect(group?.fields.title?.samples).toContain("Atlas Analytics");

    expect(group?.fields.description).toBeDefined();
    expect(group?.fields.description?.coverage).toBe(1);

    expect(group?.fields.link).toBeDefined();
    expect(group?.fields.link?.source).toBe("href");
    expect(group?.fields.link?.coverage).toBe(1);
  });

  it("infers HOME route pattern and page type", () => {
    expect(page.pathname).toBe("/");
    expect(page.routePattern).toBe("/");
    expect(page.pageType).toBe("HOME");
  });

  it("is not low-information — plenty of server-rendered text and headings", () => {
    expect(page.lowInformation).toBe(false);
    expect(page.textLength).toBeGreaterThan(400);
    expect(page.headings.length).toBeGreaterThanOrEqual(3);
  });

  it("captures prose sections with a heading and truncated text", () => {
    expect(page.sections.length).toBeGreaterThan(0);
    const hero = page.sections.find((s) => s.text.includes("thoughtful, accessible"));
    expect(hero).toBeDefined();
    expect(hero?.heading).toBe("Hi, I'm Jordan Rivera");
  });
});

describe("extractPage — portfolio-work.html (Webflow, different item markup)", () => {
  const page = extractFixture("portfolio-work.html", "https://jordanrivera.dev/work");

  it("finds all 7 work items via the Webflow CMS item class", () => {
    const group = findGroupByCount(page.repeatedGroups, 7);
    expect(group).toBeDefined();
    expect(group?.itemSelector).toBe(".w-dyn-item");
    expect(group?.fields.title?.coverage).toBe(1);
    expect(group?.fields.link?.coverage).toBe(1);
    expect(group?.samples.length).toBeGreaterThan(0);
  });

  it("infers WORK_INDEX route pattern and page type", () => {
    expect(page.pathname).toBe("/work");
    expect(page.routePattern).toBe("/work");
    expect(page.pageType).toBe("WORK_INDEX");
  });

  it("is not low-information", () => {
    expect(page.lowInformation).toBe(false);
  });
});

describe("extractPage — framer-home.html (auto-generated class names)", () => {
  const page = extractFixture("framer-home.html", "https://caseynguyen.art/");

  it("still finds the 5-item gallery group despite generated class names", () => {
    const group = findGroupByCount(page.repeatedGroups, 5);
    expect(group).toBeDefined();
    // No stable readable class survives filtering, so detection must have
    // fallen back to a structural selector — verified to match exactly 5.
    expect(group?.itemSelector).not.toContain("framer-");
    expect(group?.fields.title?.coverage).toBe(1);
    expect(group?.fields.link?.coverage).toBe(1);
    expect(group?.fields.description?.coverage).toBe(1);
  });

  it("infers HOME route pattern and page type", () => {
    expect(page.routePattern).toBe("/");
    expect(page.pageType).toBe("HOME");
  });

  it("is not low-information", () => {
    expect(page.lowInformation).toBe(false);
  });
});

describe("extractPage — client-rendered.html (empty shell)", () => {
  const page = extractFixture("client-rendered.html", "https://example-app.dev/");

  it("is low-information — almost no server-rendered text or headings", () => {
    expect(page.lowInformation).toBe(true);
    expect(page.textLength).toBeLessThan(400);
    expect(page.headings.length).toBeLessThan(3);
  });

  it("finds no repeated groups in an empty shell", () => {
    expect(page.repeatedGroups).toHaveLength(0);
  });
});

describe("buildRepresentation", () => {
  const home = extractFixture("portfolio-home.html", "https://jordanrivera.dev/");
  const work = extractFixture("portfolio-work.html", "https://jordanrivera.dev/work");

  const rep = buildRepresentation([home, work], {
    origin: "https://jordanrivera.dev",
    entryUrl: home.url,
    failures: [{ url: "https://jordanrivera.dev/broken", reason: "http_404" }],
  });

  it("picks the higher-confidence platform across pages (Webflow over the custom home page)", () => {
    expect(rep.platform.platform).toBe("WEBFLOW");
  });

  it("merges navigation across pages, deduped by href", () => {
    const hrefs = rep.navigation.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(rep.navigation.some((l) => l.pathname === "/")).toBe(true);
    // GitHub only appears in the home page's nav.
    expect(rep.navigation.some((l) => l.href.includes("github.com"))).toBe(true);
  });

  it("summarises route patterns across pages", () => {
    expect(rep.routePatterns).toEqual(["/", "/work"]);
  });

  it("passes failures through untouched", () => {
    expect(rep.failures).toEqual([
      { url: "https://jordanrivera.dev/broken", reason: "http_404" },
    ]);
  });

  it("is not low-information when most pages have real content", () => {
    expect(rep.lowInformation).toBe(false);
  });

  it("marks the site low-information when most pages are client-rendered shells", () => {
    const shell1 = extractFixture("client-rendered.html", "https://example-app.dev/");
    const shell2 = extractFixture("client-rendered.html", "https://example-app.dev/about");
    const siteRep = buildRepresentation([shell1, shell2, home], {
      origin: "https://example-app.dev",
      entryUrl: shell1.url,
      failures: [],
    });
    expect(siteRep.lowInformation).toBe(true);
  });
});

describe("adversarial input — script content and javascript: links never leak", () => {
  const ADVERSARIAL_HTML = `<!DOCTYPE html>
<html><head><title>Adversarial Test</title></head>
<body>
<script>const secret = document.cookie; console.log(secret, "alert(1)");</script>
<main>
<section>
<h1>Adversarial Page</h1>
<p>This paragraph exists purely to give the section extractor enough visible text to pass its one hundred twenty character minimum threshold for capture during this deterministic extraction test.</p>
</section>
<a href="javascript:alert(1)">Click me</a>
<a href="https://example.com/safe">Safe link</a>
</main>
</body></html>`;

  const page = extractPage(ADVERSARIAL_HTML, {
    url: "https://example.com/",
    origin: "https://example.com",
    httpStatus: 200,
    contentType: "text/html",
    byteSize: Buffer.byteLength(ADVERSARIAL_HTML, "utf8"),
  });

  it("never includes the javascript: link in extracted links", () => {
    expect(page.links.some((l) => l.href.startsWith("javascript:"))).toBe(false);
    expect(page.links.some((l) => l.href.includes("/safe"))).toBe(true);
  });

  it("never leaks script content into any extracted string field", () => {
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("document.cookie");
    expect(serialized).not.toContain("alert(1)");
  });
});
