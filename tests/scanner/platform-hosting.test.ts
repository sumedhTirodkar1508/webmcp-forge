import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import { fingerprintPlatform } from "@/lib/scanner/platform";

/**
 * Hosting is not a framework.
 *
 * `*.vercel.app` was treated as proof of Next.js, so our own plain-HTML demo
 * portfolio was classified NEXTJS and shown Next.js installation instructions
 * for a site containing no Next.js at all. Vercel hosts anything; Next.js must
 * be recognised from real markup evidence instead.
 */

function fingerprint(html: string, url: string) {
  return fingerprintPlatform(html, load(html), url);
}

const STATIC_HTML = `<!doctype html><html><head><title>Alex Rivera</title></head>
  <body><main><h1>Alex Rivera</h1>
  <p>Product designer. Plain hand-written HTML, no framework anywhere.</p>
  <section id="work"><h2>Work</h2></section></main></body></html>`;

const NEXT_HTML = `<!doctype html><html><head><title>Portfolio</title></head>
  <body><div id="__next"><h1>Portfolio</h1><p>Built with Next.js.</p></div>
  <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
  <script src="/_next/static/chunks/main.js"></script></body></html>`;

describe("platform detection on generic hosting", () => {
  it("does not call plain static HTML on vercel.app a Next.js site", () => {
    const result = fingerprint(
      STATIC_HTML,
      "https://webmcp-forge-demo-portfolio.vercel.app/",
    );

    expect(result.platform).not.toBe("NEXTJS");
    expect(result.platform).toBe("CUSTOM");
    expect(result.evidence.join(" ")).not.toContain("vercel.app");
  });

  it("still detects Next.js on vercel.app when the markup proves it", () => {
    const result = fingerprint(NEXT_HTML, "https://something.vercel.app/");

    expect(result.platform).toBe("NEXTJS");
    // Classified from real evidence, not from where it happens to be hosted.
    expect(result.evidence.join(" ")).toMatch(/__NEXT_DATA__|_next\/static/);
  });

  it("detects Next.js on a custom domain from the same evidence", () => {
    expect(fingerprint(NEXT_HTML, "https://portfolio.example/").platform).toBe("NEXTJS");
  });

  it("treats plain HTML on a custom domain the same as on vercel.app", () => {
    const hosted = fingerprint(STATIC_HTML, "https://demo.vercel.app/");
    const custom = fingerprint(STATIC_HTML, "https://demo.example/");

    // Hosting must not change the answer at all.
    expect(hosted.platform).toBe(custom.platform);
  });

  it("keeps builder-owned hostnames as genuine evidence", () => {
    // These domains belong to the builder, so serving from one really does say
    // how the site was made.
    expect(fingerprint(STATIC_HTML, "https://x.framer.app/").platform).toBe("FRAMER");
    expect(fingerprint(STATIC_HTML, "https://x.webflow.io/").platform).toBe("WEBFLOW");
    expect(fingerprint(STATIC_HTML, "https://x.wixsite.com/site").platform).toBe("WIX");
  });
});
