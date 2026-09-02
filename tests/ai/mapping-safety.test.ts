import { describe, expect, it } from "vitest";

import {
  isSafeSelector,
  listMappingSchema,
  siteMappingSchema,
} from "@/lib/ai/mapping-schema";
import { resolveMapping } from "@/lib/ai/resolve-mapping";
import { semanticResultSchema } from "@/lib/ai/semantic-schema";
import type { PageExtraction, ScanRepresentation } from "@/lib/scanner/types";

/**
 * The AI trust boundary.
 *
 * Two claims are tested here, and they are the reason it is safe to let a
 * language model participate in generating configuration at all:
 *
 *   1. The model's output schema cannot express a selector. It can only
 *      reference groups and field names the deterministic scanner produced.
 *   2. Even if it could, the mapping schema refuses anything that is not a
 *      plain CSS selector.
 */

describe("isSafeSelector", () => {
  it("accepts ordinary CSS selectors", () => {
    for (const selector of [
      ".project-card",
      "#work .card > h3",
      "article[data-id]",
      "ul.skills li",
      'a[href^="/work"]',
      ".grid > div:nth-child(2)",
      "main section h2, main section h3",
    ]) {
      expect(isSafeSelector(selector)).toBe(true);
    }
  });

  it("rejects anything that could carry code or markup", () => {
    for (const attack of [
      "javascript:alert(1)",
      "<img src=x onerror=alert(1)>",
      ".a; alert(1)",
      ".a{color:red}",
      "div\;alert(1)",
      "expression(alert(1))",
      'div[style="background:url(javascript:alert(1))"]',
      "</style><script>alert(1)</script>",
    ]) {
      expect(isSafeSelector(attack), attack).toBe(false);
    }
  });

  it("rejects empty and absurdly long selectors", () => {
    expect(isSafeSelector("")).toBe(false);
    expect(isSafeSelector("a".repeat(301))).toBe(false);
  });
});

describe("the mapping schema", () => {
  it("refuses a list mapping whose selector is not a selector", () => {
    const result = listMappingSchema.safeParse({
      route: "/",
      itemSelector: "<script>alert(1)</script>",
      fields: { title: { selector: "h3", source: "text" } },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a field that asks for an attribute without naming one", () => {
    const result = listMappingSchema.safeParse({
      route: "/",
      itemSelector: ".card",
      fields: { title: { selector: "h3", source: "attr" } },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a navigation path that is not same-origin", () => {
    for (const path of ["https://evil.example", "//evil.example", "evil"]) {
      const result = siteMappingSchema.safeParse({
        version: 1,
        navigation: { items: [{ label: "x", path }] },
      });
      expect(result.success, path).toBe(false);
    }
  });

  it("refuses an unknown field source", () => {
    const result = listMappingSchema.safeParse({
      route: "/",
      itemSelector: ".card",
      fields: { title: { selector: "h3", source: "eval" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("the AI output schema", () => {
  it("has no field anywhere that accepts a selector", () => {
    // The model answers with references, not selectors. If someone ever adds a
    // selector-shaped field to this schema, this test is the tripwire.
    const shape = JSON.stringify(semanticResultSchema.shape);
    expect(shape.toLowerCase()).not.toContain("selector");
  });

  it("rejects a group id that is not a scanned group reference", () => {
    for (const groupId of ["<script>", ".project-card", "g".repeat(20), ""]) {
      const result = semanticResultSchema.safeParse({
        projects: { pageUrl: "https://x.test/", groupId, fields: {} },
        navigation: [],
        warnings: [],
      });
      expect(result.success, groupId).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

function page(overrides: Partial<PageExtraction> = {}): PageExtraction {
  return {
    url: "https://x.test/work",
    pathname: "/work",
    routePattern: "/work",
    pageType: "WORK_INDEX",
    openGraph: {},
    jsonLd: [],
    platform: { platform: "CUSTOM", confidence: 0.5, evidence: [] },
    headings: [{ level: 1, text: "Work" }],
    nav: [],
    links: [],
    sections: [],
    repeatedGroups: [
      {
        id: "g1",
        itemSelector: ".project-card",
        count: 7,
        fields: {
          title: { selector: "h3", source: "text", coverage: 1, samples: ["A"] },
          link: { selector: "a", source: "href", coverage: 1, samples: ["/work/a"] },
        },
        samples: ["A"],
        score: 10,
      },
    ],
    contact: { emails: [], phones: [], socials: [] },
    textLength: 900,
    lowInformation: false,
    httpStatus: 200,
    byteSize: 1000,
    ...overrides,
  };
}

function representation(): ScanRepresentation {
  return {
    origin: "https://x.test",
    entryUrl: "https://x.test/work",
    platform: { platform: "CUSTOM", confidence: 0.5, evidence: [] },
    pages: [page()],
    routePatterns: ["/work"],
    navigation: [{ label: "Work", href: "https://x.test/work", pathname: "/work" }],
    failures: [],
    lowInformation: false,
  };
}

describe("resolveMapping", () => {
  it("builds selectors from the scan, not from the model", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      projects: {
        pageUrl: "https://x.test/work",
        groupId: "g1",
        fields: { title: "title", link: "link" },
        confidence: 0.9,
      },
      navigation: [],
      warnings: [],
    });

    // These values exist nowhere in the model's output — they came from the
    // scanned candidate group.
    expect(resolved.mapping.projects?.itemSelector).toBe(".project-card");
    expect(resolved.mapping.projects?.fields.title).toEqual({
      selector: "h3",
      source: "text",
    });
    expect(resolved.mapping.projects?.expectedCount).toBe(7);
    expect(resolved.available.has("projects")).toBe(true);
  });

  it("drops a reference to a group that does not exist", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      projects: {
        pageUrl: "https://x.test/work",
        groupId: "g99",
        fields: { title: "title" },
        confidence: 1,
      },
      navigation: [],
      warnings: [],
    });

    expect(resolved.mapping.projects).toBeUndefined();
    expect(resolved.available.has("projects")).toBe(false);
    expect(resolved.warnings.join(" ")).toContain("projects");
  });

  it("drops a reference to a page that was never scanned", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      projects: {
        pageUrl: "https://elsewhere.test/work",
        groupId: "g1",
        fields: { title: "title" },
        confidence: 1,
      },
      navigation: [],
      warnings: [],
    });

    expect(resolved.mapping.projects).toBeUndefined();
  });

  it("ignores field names the group does not have", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      projects: {
        pageUrl: "https://x.test/work",
        groupId: "g1",
        fields: { title: "title", description: "made_up_field" },
        confidence: 1,
      },
      navigation: [],
      warnings: [],
    });

    expect(resolved.mapping.projects?.fields.title).toBeDefined();
    expect(resolved.mapping.projects?.fields.description).toBeUndefined();
  });

  it("keeps only navigation paths the crawler actually saw", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      navigation: [
        { label: "Work", path: "/work" },
        { label: "Phantom", path: "/does-not-exist" },
      ],
      warnings: [],
    });

    const paths = resolved.mapping.navigation?.items.map((item) => item.path);
    expect(paths).toEqual(["/work"]);
  });

  it("falls back to crawled navigation when the model gives none", () => {
    const resolved = resolveMapping(representation(), {
      platformGuess: "CUSTOM",
      navigation: [],
      warnings: [],
    });

    expect(resolved.mapping.navigation?.items).toEqual([{ label: "Work", path: "/work" }]);
  });
});
