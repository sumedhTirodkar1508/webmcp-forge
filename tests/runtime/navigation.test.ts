import { describe, expect, it } from "vitest";

import { isSameDocumentFragmentNavigation } from "@/runtime/tools";

describe("same-document fragment navigation", () => {
  it("uses in-document navigation for a fragment on the current document", () => {
    expect(
      isSameDocumentFragmentNavigation(
        "https://portfolio.example/?mode=full#top",
        "https://portfolio.example/?mode=full#work",
      ),
    ).toBe(true);
  });

  it("requires the same origin, path, and query", () => {
    expect(isSameDocumentFragmentNavigation("https://a.example/", "https://b.example/#work")).toBe(false);
    expect(isSameDocumentFragmentNavigation("https://a.example/", "https://a.example/about#work")).toBe(false);
    expect(isSameDocumentFragmentNavigation("https://a.example/?a=1", "https://a.example/?a=2#work")).toBe(false);
  });
});
