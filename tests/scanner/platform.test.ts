import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import { fingerprintPlatform, mergeFingerprints } from "@/lib/scanner/platform";

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("fingerprintPlatform", () => {
  it("detects Webflow from data-wf-page, the generator meta tag, and asset host", () => {
    const html = readFixture("portfolio-work.html");
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://jordanrivera.dev/work");

    expect(fp.platform).toBe("WEBFLOW");
    expect(fp.confidence).toBeGreaterThan(0.5);
    expect(fp.evidence.length).toBeGreaterThan(0);
    expect(fp.evidence.some((e) => e.includes("data-wf-page"))).toBe(true);
  });

  it("detects Framer from framerusercontent.com, data-framer-name, and the badge container", () => {
    const html = readFixture("framer-home.html");
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://caseynguyen.art/");

    expect(fp.platform).toBe("FRAMER");
    expect(fp.confidence).toBeGreaterThan(0.5);
    expect(fp.evidence.some((e) => e.includes("framerusercontent.com"))).toBe(
      true,
    );
  });

  it("detects Next.js from __NEXT_DATA__ and /_next/static/", () => {
    const html = readFixture("client-rendered.html");
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://example-app.dev/");

    expect(fp.platform).toBe("NEXTJS");
    expect(fp.evidence.some((e) => e.includes("__NEXT_DATA__"))).toBe(true);
  });

  it("falls back to CUSTOM for a hand-built page with real content and no known signature", () => {
    const html = readFixture("portfolio-home.html");
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://jordanrivera.dev/");

    expect(fp.platform).toBe("CUSTOM");
    expect(fp.confidence).toBeGreaterThan(0);
    expect(fp.confidence).toBeLessThan(1);
  });

  it("returns UNKNOWN for a page with no real content and no signature", () => {
    const html = "<html><head><title>Empty</title></head><body></body></html>";
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://example.com/");

    expect(fp.platform).toBe("UNKNOWN");
    expect(fp.confidence).toBe(0);
  });

  it("detects Wix from a static.parastorage.com reference and SITE_CONTAINER id", () => {
    const html =
      "<html><head><title>Wix site</title></head><body id=\"SITE_CONTAINER\"><script src=\"https://static.parastorage.com/services/foo.js\"></script><main><h1>Welcome</h1><p>" +
      "A wix-powered small business site with plenty of real content to look legitimate here.".repeat(2) +
      "</p></main></body></html>";
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://example.wixsite.com/mysite");

    expect(fp.platform).toBe("WIX");
  });

  it("detects Squarespace from static1.squarespace.com and SQUARESPACE_CONTEXT", () => {
    const html =
      "<html><head><title>Squarespace site</title></head><body><script>Static.SQUARESPACE_CONTEXT = {};</script>" +
      "<img src=\"https://static1.squarespace.com/foo.jpg\"><main><h1>Hello</h1><p>Plenty of real content on this squarespace-hosted page to look legitimate.</p></main></body></html>";
    const $ = load(html);
    const fp = fingerprintPlatform(html, $, "https://example.com/");

    expect(fp.platform).toBe("SQUARESPACE");
  });
});

describe("mergeFingerprints", () => {
  it("picks the highest-confidence non-UNKNOWN platform and unions evidence", () => {
    const merged = mergeFingerprints([
      { platform: "UNKNOWN", confidence: 0, evidence: [] },
      { platform: "WEBFLOW", confidence: 0.4, evidence: ["a", "b"] },
      { platform: "WEBFLOW", confidence: 0.9, evidence: ["b", "c"] },
    ]);

    expect(merged.platform).toBe("WEBFLOW");
    expect(merged.confidence).toBe(0.9);
    expect(merged.evidence).toEqual(["a", "b", "c"]);
  });

  it("caps the merged evidence list at 8 entries", () => {
    const evidence = Array.from({ length: 12 }, (_, i) => `signal-${i}`);
    const merged = mergeFingerprints([
      { platform: "FRAMER", confidence: 0.8, evidence },
    ]);

    expect(merged.evidence.length).toBeLessThanOrEqual(8);
  });

  it("returns UNKNOWN when every fingerprint is UNKNOWN", () => {
    const merged = mergeFingerprints([
      { platform: "UNKNOWN", confidence: 0, evidence: [] },
      { platform: "UNKNOWN", confidence: 0, evidence: [] },
    ]);

    expect(merged.platform).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for an empty list", () => {
    expect(mergeFingerprints([]).platform).toBe("UNKNOWN");
  });
});
