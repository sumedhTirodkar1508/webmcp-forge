// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FieldMapping } from "@/lib/ai/mapping-schema";
import { deriveHeuristicMapping } from "@/lib/ai/resolve-mapping";
import { buildRepresentation, extractPage } from "@/lib/scanner/extract";
import {
  MAX_ITEMS,
  cleanText,
  extractList,
  extractSingle,
  findItem,
  readField,
  routeMatches,
  safeQuery,
  safeQueryAll,
  searchItems,
} from "@/runtime/dom-extract";

import {
  PORTFOLIO_ORIGIN,
  buildProjectsMapping,
  createDocument,
  portfolioHtml,
} from "./helpers";

const BASE_URL = `${PORTFOLIO_ORIGIN}/`;

describe("cleanText", () => {
  it("collapses internal whitespace to single spaces", () => {
    expect(cleanText("a   b\nc\t\td")).toBe("a b c d");
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanText("   padded value   ")).toBe("padded value");
  });

  it("truncates long values with an ellipsis, at the field length ceiling", () => {
    const long = "a".repeat(2500);
    const result = cleanText(long);
    expect(result.length).toBe(2000);
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, 1999)).toBe("a".repeat(1999));
  });

  it("leaves a value at or under the ceiling untouched", () => {
    const exact = "b".repeat(2000);
    expect(cleanText(exact)).toBe(exact);
  });

  it("handles null and undefined as empty string, never throwing", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
    expect(cleanText("")).toBe("");
  });
});

describe("modern component mapping in the live DOM", () => {
  const html = readFileSync(
    join(process.cwd(), "tests/fixtures/modern-component-portfolio.html"),
    "utf8",
  );
  const page = extractPage(html, {
    url: "https://components.example/",
    origin: "https://components.example",
    httpStatus: 200,
    contentType: "text/html",
    byteSize: Buffer.byteLength(html),
  });
  const mapping = deriveHeuristicMapping(
    buildRepresentation([page], {
      origin: "https://components.example",
      entryUrl: "https://components.example/",
      failures: [],
    }),
  ).mapping;
  const doc = createDocument(html);

  it("executes all scoped collection selectors with their expected counts", () => {
    for (const [key, expected] of [
      ["projects", 3],
      ["skills", 3],
      ["experience", 2],
      ["education", 2],
    ] as const) {
      const list = mapping[key];
      expect(list).toBeDefined();
      expect(extractList(doc, list!, "https://components.example/").matchCount).toBe(expected);
    }
  });

  it("returns skill category values as a readable delimited list", () => {
    const result = extractList(doc, mapping.skills!, "https://components.example/");
    expect(result.items[0]?.fields.items).toBe("TypeScript, Python");
  });
});

describe("safeQueryAll / safeQuery", () => {
  const doc = createDocument(portfolioHtml({ projectCount: 2 }));

  it("returns [] / null for a malformed selector instead of throwing", () => {
    expect(() => safeQueryAll(doc, ":::")).not.toThrow();
    expect(safeQueryAll(doc, ":::")).toEqual([]);
    expect(() => safeQuery(doc, ":::")).not.toThrow();
    expect(safeQuery(doc, ":::")).toBeNull();
  });

  it("returns [] / null for another malformed selector (unbalanced brackets)", () => {
    expect(safeQueryAll(doc, "[[")).toEqual([]);
    expect(safeQuery(doc, "[[")).toBeNull();
  });

  it("works normally for a valid selector", () => {
    expect(safeQueryAll(doc, ".project-card")).toHaveLength(2);
    expect(safeQuery(doc, ".project-card")).not.toBeNull();
  });

  it("returns [] / null for an empty selector", () => {
    expect(safeQueryAll(doc, "")).toEqual([]);
    expect(safeQuery(doc, "")).toBeNull();
  });
});

describe("readField", () => {
  const doc = createDocument(portfolioHtml({ projectCount: 1 }));
  const item = doc.querySelector(".project-card");
  if (!item) throw new Error("fixture is missing its project card");

  it("reads text, collapsed and trimmed", () => {
    const mapping: FieldMapping = { selector: ".project-title", source: "text" };
    expect(readField(item, mapping, BASE_URL)).toBe("Project 1");
  });

  it("keeps nested-list values distinct", () => {
    const wrapper = doc.createElement("div");
    wrapper.innerHTML = "<ul><li>TypeScript</li><li>Postgres</li><li>Redis</li></ul>";
    expect(readField(wrapper, { selector: "ul", source: "text" }, BASE_URL)).toBe(
      "TypeScript, Postgres, Redis",
    );
  });

  it("resolves an href against the base URL", () => {
    const mapping: FieldMapping = { selector: ".project-link", source: "href" };
    expect(readField(item, mapping, BASE_URL)).toBe(`${PORTFOLIO_ORIGIN}/work/project-1`);
  });

  it("rejects a javascript: href, returning empty string", () => {
    const jsDoc = createDocument(
      `<a class="bad" href="javascript:alert(1)">click</a>`,
    );
    const link = jsDoc.querySelector(".bad");
    if (!link) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "href" };
    expect(readField(link, mapping, BASE_URL)).toBe("");
  });

  it("rejects a mailto: href, returning empty string", () => {
    const mailDoc = createDocument(
      `<a class="bad" href="mailto:me@example.com">email</a>`,
    );
    const link = mailDoc.querySelector(".bad");
    if (!link) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "href" };
    expect(readField(link, mapping, BASE_URL)).toBe("");
  });

  it("reads src, resolved against the base URL", () => {
    const mapping: FieldMapping = { selector: "img", source: "src" };
    expect(readField(item, mapping, BASE_URL)).toBe(`${PORTFOLIO_ORIGIN}/img/project-1.png`);
  });

  it("falls back to data-src when src is absent", () => {
    const lazyDoc = createDocument(`<img class="lazy" data-src="/img/lazy.png" />`);
    const img = lazyDoc.querySelector(".lazy");
    if (!img) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "src" };
    expect(readField(img, mapping, BASE_URL)).toBe(`${PORTFOLIO_ORIGIN}/img/lazy.png`);
  });

  it("reads an attribute when `attribute` is set", () => {
    const attrDoc = createDocument(`<div class="tag" data-role="lead">x</div>`);
    const el = attrDoc.querySelector(".tag");
    if (!el) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "attr", attribute: "data-role" };
    expect(readField(el, mapping, BASE_URL)).toBe("lead");
  });

  it("returns empty string for source `attr` with no `attribute` configured", () => {
    const attrDoc = createDocument(`<div class="tag" data-role="lead">x</div>`);
    const el = attrDoc.querySelector(".tag");
    if (!el) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "attr" };
    expect(readField(el, mapping, BASE_URL)).toBe("");
  });

  it("treats an empty selector as the item element itself", () => {
    const skillsDoc = createDocument(portfolioHtml({ skills: ["Go"] }));
    const li = skillsDoc.querySelector(".skills-list li");
    if (!li) throw new Error("fixture missing");
    const mapping: FieldMapping = { selector: "", source: "text" };
    expect(readField(li, mapping, BASE_URL)).toBe("Go");
  });
});

describe("routeMatches", () => {
  it("`*` matches anything", () => {
    expect(routeMatches("*", "/")).toBe(true);
    expect(routeMatches("*", "/work/anything/deep")).toBe(true);
    expect(routeMatches("*", "")).toBe(true);
  });

  it("`/` matches the root path, including with a trailing slash", () => {
    expect(routeMatches("/", "/")).toBe(true);
    expect(routeMatches("/", "//")).toBe(true);
  });

  it("`/` does not match a different path", () => {
    expect(routeMatches("/", "/about")).toBe(false);
  });

  it("`/work/*` matches a nested path but not the index or a deeper path", () => {
    expect(routeMatches("/work/*", "/work/a")).toBe(true);
    expect(routeMatches("/work/*", "/work")).toBe(false);
    expect(routeMatches("/work/*", "/work/a/b")).toBe(false);
  });

  it("is case-insensitive on literal segments", () => {
    expect(routeMatches("/Work", "/work")).toBe(true);
    expect(routeMatches("/work", "/WORK")).toBe(true);
  });
});

describe("extractList", () => {
  it("extracts every item with its mapped fields", () => {
    const doc = createDocument(portfolioHtml({ projectCount: 3 }));
    const result = extractList(doc, buildProjectsMapping(), BASE_URL);

    expect(result.items).toHaveLength(3);
    expect(result.matchCount).toBe(3);
    expect(result.broken).toBe(false);
    expect(result.items[0]?.fields).toEqual({
      title: "Project 1",
      description: "Description of project 1.",
      link: `${PORTFOLIO_ORIGIN}/work/project-1`,
      image: `${PORTFOLIO_ORIGIN}/img/project-1.png`,
      tags: "tag-1, sample",
    });
  });

  it("skips items that yield no fields at all", () => {
    const html = `
      <section class="project-grid">
        <article class="project-card"></article>
        <article class="project-card">
          <h3 class="project-title">Real Project</h3>
        </article>
      </section>`;
    const doc = createDocument(html);
    const result = extractList(doc, buildProjectsMapping(), BASE_URL);

    // Both elements matched the selector, but only one yielded a field.
    expect(result.matchCount).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.fields.title).toBe("Real Project");
  });

  it("sets broken: true when the item selector matches nothing", () => {
    const doc = createDocument(portfolioHtml({ projectCount: 0 }));
    const result = extractList(doc, buildProjectsMapping(), BASE_URL);

    expect(result.matchCount).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.broken).toBe(true);
  });

  it("honours containerSelector, ignoring matches outside the container", () => {
    const html = `
      <section class="project-grid">
        <article class="project-card"><h3 class="project-title">In Grid A</h3></article>
        <article class="project-card"><h3 class="project-title">In Grid B</h3></article>
      </section>
      <section class="archive">
        <article class="project-card"><h3 class="project-title">Archived, out of scope</h3></article>
      </section>`;
    const doc = createDocument(html);
    const mapping = buildProjectsMapping({ containerSelector: ".project-grid" });
    const result = extractList(doc, mapping, BASE_URL);

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.fields.title)).toEqual(["In Grid A", "In Grid B"]);
  });

  it("respects the MAX_ITEMS ceiling while still reporting the true match count", () => {
    const total = MAX_ITEMS + 10;
    const doc = createDocument(portfolioHtml({ projectCount: total }));
    const result = extractList(doc, buildProjectsMapping(), BASE_URL);

    expect(result.items.length).toBe(MAX_ITEMS);
    expect(result.matchCount).toBe(total);
  });

  it("HEADLINE: a new project added to the same mapping is visible with no re-scan", () => {
    // This is the product's central claim: the mapping is a *description of
    // structure* (a selector), not a snapshot of content. Extracting from a
    // freshly rendered 8-card page with the exact same mapping object used
    // for the 7-card page proves the eighth project needs no new
    // configuration and no AI call to become visible.
    const mapping = buildProjectsMapping();

    const sevenCardDoc = createDocument(portfolioHtml({ projectCount: 7 }));
    const before = extractList(sevenCardDoc, mapping, BASE_URL);
    expect(before.items).toHaveLength(7);

    const eightCardDoc = createDocument(portfolioHtml({ projectCount: 8 }));
    const after = extractList(eightCardDoc, mapping, BASE_URL);
    expect(after.items).toHaveLength(8);
    expect(after.items[7]?.fields.title).toBe("Project 8");
  });
});

describe("extractSingle", () => {
  it("reads mapped single values", () => {
    const doc = createDocument(portfolioHtml());
    const mapping = {
      route: "*",
      fields: {
        name: { selector: ".profile-name", source: "text" as const },
        headline: { selector: ".profile-headline", source: "text" as const },
      },
    };
    expect(extractSingle(doc, mapping, BASE_URL)).toEqual({
      name: "Jordan Rivera",
      headline: "Product designer & builder",
    });
  });

  it("skips fields whose selector matches nothing", () => {
    const doc = createDocument(portfolioHtml());
    const mapping = {
      route: "*",
      fields: {
        name: { selector: ".profile-name", source: "text" as const },
        missing: { selector: ".does-not-exist", source: "text" as const },
      },
    };
    const result = extractSingle(doc, mapping, BASE_URL);
    expect(result).toEqual({ name: "Jordan Rivera" });
    expect(result.missing).toBeUndefined();
  });
});

describe("findItem", () => {
  const doc = createDocument(portfolioHtml({ projectCount: 3 }));
  const { items } = extractList(doc, buildProjectsMapping(), BASE_URL);

  it("finds by index", () => {
    expect(findItem(items, { index: 1 })?.fields.title).toBe("Project 2");
  });

  it("finds by id", () => {
    // Cards carry a real `id` attribute ("project-N"), which extractList
    // prefers over `data-id`.
    expect(findItem(items, { id: "project-2" })?.fields.title).toBe("Project 2");
  });

  it("finds by exact title", () => {
    expect(findItem(items, { title: "Project 2" })?.index).toBe(1);
  });

  it("finds by partial title", () => {
    expect(findItem(items, { title: "oject 2" })?.index).toBe(1);
  });

  it("returns undefined for no match", () => {
    expect(findItem(items, { title: "Nonexistent" })).toBeUndefined();
    expect(findItem(items, { id: "nope" })).toBeUndefined();
    expect(findItem(items, {})).toBeUndefined();
  });

  it("gives index precedence over id/title", () => {
    const match = findItem(items, { index: 0, id: "project-2", title: "Project 2" });
    expect(match?.index).toBe(0);
  });
});

describe("searchItems", () => {
  const doc = createDocument(`
    <section class="project-grid">
      <article class="project-card">
        <h3 class="project-title">Atlas Dashboard</h3>
        <p class="project-desc">Analytics for logistics teams.</p>
      </article>
      <article class="project-card">
        <h3 class="project-title">Personal Site</h3>
        <p class="project-desc">Built with an atlas of design references.</p>
      </article>
      <article class="project-card">
        <h3 class="project-title">Weather App</h3>
        <p class="project-desc">Forecasts and maps.</p>
      </article>
    </section>`);
  const { items } = extractList(doc, buildProjectsMapping(), BASE_URL);

  it("scores a title match above a match in another field", () => {
    const results = searchItems(items, "atlas", 10);
    expect(results[0]?.fields.title).toBe("Atlas Dashboard");
    expect(results.map((r) => r.fields.title)).toContain("Personal Site");
  });

  it("respects the limit", () => {
    const results = searchItems(items, "a", 1);
    expect(results).toHaveLength(1);
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(searchItems(items, "", 10)).toEqual([]);
    expect(searchItems(items, "   ", 10)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchItems(items, "ATLAS", 10)[0]?.fields.title).toBe("Atlas Dashboard");
  });

  it("handles multi-term queries", () => {
    const results = searchItems(items, "weather maps", 10);
    expect(results[0]?.fields.title).toBe("Weather App");
  });
});
