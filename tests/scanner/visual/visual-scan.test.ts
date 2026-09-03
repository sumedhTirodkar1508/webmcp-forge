import { afterEach, describe, expect, it, vi } from "vitest";

import { resetEnvCache } from "@/lib/env";
import { assessAmbiguity } from "@/lib/scanner/visual/ambiguity";
import {
  captureForAmbiguity,
  enforceImageBounds,
  getPageRenderer,
  setPageRenderer,
  visualScanAvailable,
  type CapturedImage,
  type PageRenderer,
} from "@/lib/scanner/visual/page-renderer";
import type { PageExtraction, RepeatedGroup, ScanRepresentation } from "@/lib/scanner/types";

/**
 * Visual scan assistance.
 *
 * The properties under test are mostly about restraint: it must not run when
 * disabled, must not run when the scan was confident, must never exceed its
 * caps, and must never take a working scan down with it when a browser fails.
 */

function group(id: string, overrides: Partial<RepeatedGroup> = {}): RepeatedGroup {
  return {
    id,
    itemSelector: `.${id}`,
    count: 5,
    fields: {
      title: { selector: "h3", source: "text", coverage: 1, samples: ["A"] },
      link: { selector: "a", source: "href", coverage: 1, samples: ["/a"] },
    },
    samples: ["A"],
    score: 10,
    ...overrides,
  };
}

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
    repeatedGroups: [group("g1")],
    contact: { emails: [], phones: [], socials: [] },
    textLength: 900,
    lowInformation: false,
    httpStatus: 200,
    byteSize: 1000,
    ...overrides,
  };
}

function representation(pages: PageExtraction[]): ScanRepresentation {
  return {
    origin: "https://x.test",
    entryUrl: "https://x.test/work",
    platform: { platform: "CUSTOM", confidence: 0.5, evidence: [] },
    pages,
    routePatterns: ["/work"],
    navigation: [],
    failures: [],
    lowInformation: false,
  };
}

function image(bytes: number, overrides: Partial<CapturedImage> = {}): CapturedImage {
  return {
    mimeType: "image/webp",
    data: new Uint8Array(bytes),
    section: "projects",
    pageUrl: "https://x.test/work",
    ...overrides,
  };
}

const BOUNDS = { maxImages: 3, maxBytesPerImage: 600_000, maxTotalBytes: 1_500_000 };

function setVisualEnabled(enabled: boolean): void {
  vi.stubEnv("VISUAL_SCAN_ENABLED", enabled ? "true" : "false");
  // The environment is parsed once and cached; tests need it re-read.
  resetEnvCache();
}

afterEach(() => {
  setPageRenderer(null);
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("ambiguity assessment", () => {
  it("does not escalate a confident scan", () => {
    // One clearly-best group with full field coverage: nothing to disambiguate.
    const assessment = assessAmbiguity(representation([page()]));
    expect(assessment.ambiguous).toBe(false);
    expect(assessment.sections).toEqual([]);
  });

  it("does not escalate merely because a page is large", () => {
    const many = page({
      repeatedGroups: [group("g1", { score: 40 }), group("g2", { score: 5 })],
      textLength: 500_000,
      headings: Array.from({ length: 60 }, (_, i) => ({ level: 2, text: `H${i}` })),
    });
    // Size is not ambiguity — the score gap is decisive.
    expect(assessAmbiguity(representation([many])).ambiguous).toBe(false);
  });

  it("escalates when two candidate groups score almost the same", () => {
    const close = page({
      repeatedGroups: [group("g1", { score: 10 }), group("g2", { score: 9.5 })],
    });
    const assessment = assessAmbiguity(representation([close]));
    expect(assessment.ambiguous).toBe(true);
    expect(assessment.sections[0]?.reason).toBe("competing_groups");
    expect(assessment.sections[0]?.groupIds).toEqual(["g1", "g2"]);
  });

  it("escalates when the best group's fields are too sparse to label", () => {
    const sparse = page({
      repeatedGroups: [
        group("g1", {
          score: 10,
          fields: {
            title: { selector: "h3", source: "text", coverage: 0.3, samples: [] },
          },
        }),
      ],
    });
    const assessment = assessAmbiguity(representation([sparse]));
    expect(assessment.sections[0]?.reason).toBe("low_field_coverage");
  });

  it("orders projects ahead of lower-priority sections", () => {
    const work = page({
      url: "https://x.test/work",
      pageType: "WORK_INDEX",
      repeatedGroups: [group("g1", { score: 10 }), group("g2", { score: 9.6 })],
    });
    const education = page({
      url: "https://x.test/education",
      pathname: "/education",
      pageType: "EDUCATION",
      repeatedGroups: [group("g1", { score: 10 }), group("g2", { score: 9.6 })],
    });

    const sections = assessAmbiguity(representation([education, work])).sections;
    expect(sections[0]?.section).toBe("projects");
  });
});

describe("image bounds", () => {
  it("accepts images inside every limit", () => {
    const result = enforceImageBounds([image(1000), image(2000)], BOUNDS);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it("rejects an unsupported MIME type", () => {
    const result = enforceImageBounds(
      [image(1000, { mimeType: "image/gif" as unknown as CapturedImage["mimeType"] })],
      BOUNDS,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("unsupported_mime");
  });

  it("rejects an oversized image", () => {
    const result = enforceImageBounds([image(BOUNDS.maxBytesPerImage + 1)], BOUNDS);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("too_large");
  });

  it("never accepts more than three images", () => {
    const result = enforceImageBounds(
      [image(100), image(100), image(100), image(100), image(100)],
      BOUNDS,
    );
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason === "too_many")).toBe(true);
  });

  it("enforces a total byte ceiling across images", () => {
    // Each is under the per-image cap (600 kB), but three of them exceed the
    // 1.5 MB total, so the third is refused on the aggregate limit.
    const big = 550_000;
    expect(big).toBeLessThan(BOUNDS.maxBytesPerImage);
    expect(big * 3).toBeGreaterThan(BOUNDS.maxTotalBytes);

    const result = enforceImageBounds([image(big), image(big), image(big)], BOUNDS);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected.some((r) => r.reason === "total_too_large")).toBe(true);
  });
});

describe("capture behaviour", () => {
  const sections = assessAmbiguity(
    representation([page({ repeatedGroups: [group("g1", { score: 10 }), group("g2", { score: 9.5 })] })]),
  ).sections;

  it("renders nothing when visual scanning is disabled", async () => {
    const capture = vi.fn();
    setPageRenderer({ name: "fake", capture } as unknown as PageRenderer);
    setVisualEnabled(false);

    const result = await captureForAmbiguity(sections);

    // Disabled means the browser is never invoked at all.
    expect(capture).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
  });

  it("renders nothing when no renderer is registered", async () => {
    setVisualEnabled(true);
    setPageRenderer(null);
    expect(getPageRenderer()).toBeNull();
    expect(visualScanAvailable()).toBe(false);
    expect((await captureForAmbiguity(sections)).images).toEqual([]);
  });

  it("continues the scan when the renderer throws", async () => {
    setPageRenderer({
      name: "broken",
      capture: async () => {
        throw new Error("chromium crashed");
      },
    });
    setVisualEnabled(true);

    const result = await captureForAmbiguity(sections);

    // A failed browser must never fail a scan whose structural extraction
    // already succeeded.
    expect(result.images).toEqual([]);
    expect(result.warnings.join(" ")).toContain("structural scan continued");
  });
});
