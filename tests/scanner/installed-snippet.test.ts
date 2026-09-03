import { describe, expect, it } from "vitest";

import { extractPage } from "@/lib/scanner/extract";

/**
 * Detecting an already-installed Forge snippet.
 *
 * This is the only reliable statement about which configuration a website is
 * ACTUALLY running. It failed silently because detection ran after the
 * extractor had stripped every `<script>` — so it could never find the snippet,
 * which is itself a script tag.
 *
 * Detection is keyed on `data-wmf-site`, never on the script's host: the
 * runtime is served by Forge and installed on someone else's website, so in
 * development that is localhost:3000 on an ngrok-hosted portfolio.
 */

const OPTIONS = {
  url: "https://spyglass-excluding-silliness.ngrok-free.dev/",
  origin: "https://spyglass-excluding-silliness.ngrok-free.dev",
  httpStatus: 200,
  contentType: "text/html",
  byteSize: 2048,
};

function page(head: string): string {
  return `<!doctype html><html><head>${head}</head><body><main><h1>Portfolio</h1>
    <p>Some text so the page is not treated as empty at all.</p></main></body></html>`;
}

/** The exact snippet installed on the demo portfolio. */
const REAL_SNIPPET = `
<script
  defer
  src="http://localhost:3000/runtime/v1.js"
  data-wmf-site="wmf_JK2CNFYWGC9S63YY4RH2E6D2"
  data-wmf-config="2">
</script>`;

describe("installed snippet detection", () => {
  it("detects the real multiline snippet with an external runtime host", () => {
    const extracted = extractPage(page(REAL_SNIPPET), OPTIONS);

    expect(extracted.installedSnippet).toEqual({
      siteId: "wmf_JK2CNFYWGC9S63YY4RH2E6D2",
      configVersion: 2,
      // Forge-hosted runtime on a different origin from the scanned site.
      runtimeSrc: "http://localhost:3000/runtime/v1.js",
    });
  });

  it("does not require the runtime host to match the scanned site", () => {
    const extracted = extractPage(page(REAL_SNIPPET), OPTIONS);
    const runtimeHost = new URL(extracted.installedSnippet!.runtimeSrc!).host;

    expect(runtimeHost).not.toBe(new URL(OPTIONS.origin).host);
    expect(extracted.installedSnippet?.siteId).toBe("wmf_JK2CNFYWGC9S63YY4RH2E6D2");
  });

  it("handles attribute ordering, quoting, async and a relative src", () => {
    const variants = [
      `<script data-wmf-config='3' data-wmf-site='wmf_JK2CNFYWGC9S63YY4RH2E6D2' src='/runtime/v1.js' async></script>`,
      `<script async src="/runtime/v1.js" data-wmf-site="wmf_JK2CNFYWGC9S63YY4RH2E6D2" data-wmf-config="3"></script>`,
      `<script\n  data-wmf-site="wmf_JK2CNFYWGC9S63YY4RH2E6D2"\n  data-wmf-config="3"\n  defer\n  src="https://forge.example/runtime/v1.js"></script>`,
    ];

    for (const variant of variants) {
      const extracted = extractPage(page(variant), OPTIONS);
      expect(extracted.installedSnippet?.siteId).toBe("wmf_JK2CNFYWGC9S63YY4RH2E6D2");
      expect(extracted.installedSnippet?.configVersion).toBe(3);
    }
  });

  it("reports no snippet when the site has none", () => {
    const extracted = extractPage(page("<script src='/app.js'></script>"), OPTIONS);
    expect(extracted.installedSnippet).toBeUndefined();
  });

  it("reports a missing or invalid config version as null, not a guess", () => {
    for (const raw of ["", "0", "abc", "latest", "-1"]) {
      const attr = raw === "" ? "" : ` data-wmf-config="${raw}"`;
      const extracted = extractPage(
        page(`<script src="/runtime/v1.js" data-wmf-site="wmf_JK2CNFYWGC9S63YY4RH2E6D2"${attr}></script>`),
        OPTIONS,
      );
      expect(extracted.installedSnippet?.siteId).toBe("wmf_JK2CNFYWGC9S63YY4RH2E6D2");
      expect(extracted.installedSnippet?.configVersion, raw).toBeNull();
    }
  });

  it("still keeps script content out of the extracted text", () => {
    const extracted = extractPage(
      page(`${REAL_SNIPPET}<script>const secret = "do-not-extract";</script>`),
      OPTIONS,
    );
    expect(JSON.stringify(extracted.sections)).not.toContain("do-not-extract");
    expect(extracted.installedSnippet?.configVersion).toBe(2);
  });
});

describe("attributing a detected snippet to a site", () => {
  /** Mirrors `detectedInstalledVersion` in builder-service.ts. */
  function installedVersionFor(
    snippet: { siteId: string; configVersion: number | null } | undefined,
    publicId: string,
  ): number | null {
    if (!snippet) return null;
    if (snippet.siteId !== publicId) return null;
    const v = snippet.configVersion;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
  }

  it("claims the installation when the site id matches", () => {
    const snippet = extractPage(page(REAL_SNIPPET), OPTIONS).installedSnippet;
    expect(installedVersionFor(snippet, "wmf_JK2CNFYWGC9S63YY4RH2E6D2")).toBe(2);
  });

  it("does NOT claim a snippet belonging to a different Forge site", () => {
    const snippet = extractPage(page(REAL_SNIPPET), OPTIONS).installedSnippet;
    // Genuinely on the page, but it is someone else's installation.
    expect(installedVersionFor(snippet, "wmf_SOMEONEELSESSITEID000000")).toBeNull();
  });
});
