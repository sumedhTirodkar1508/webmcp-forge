import { describe, expect, it } from "vitest";

import {
  inferPageType,
  inferRoutePattern,
  summarizeRoutePatterns,
} from "@/lib/scanner/routes";

describe("inferRoutePattern", () => {
  it("keeps the root path as /", () => {
    expect(inferRoutePattern("/")).toBe("/");
  });

  it("keeps a single literal segment as-is", () => {
    expect(inferRoutePattern("/about")).toBe("/about");
  });

  it("collapses the second segment to a wildcard", () => {
    expect(inferRoutePattern("/work/project-a")).toBe("/work/*");
  });

  it("collapses every segment after the first to a wildcard", () => {
    expect(inferRoutePattern("/projects/foo/bar")).toBe("/projects/*/*");
  });

  it("lowercases the pattern", () => {
    expect(inferRoutePattern("/Work/Project-A")).toBe("/work/*");
  });

  it("strips a trailing slash", () => {
    expect(inferRoutePattern("/about/")).toBe("/about");
    expect(inferRoutePattern("/work/project-a/")).toBe("/work/*");
  });
});

describe("inferPageType", () => {
  it("classifies the root as HOME", () => {
    expect(inferPageType("/")).toBe("HOME");
  });

  it.each(["/about", "/about-me", "/bio", "/info"])(
    "classifies %s as ABOUT",
    (path) => {
      expect(inferPageType(path)).toBe("ABOUT");
    },
  );

  it.each(["/work", "/projects", "/portfolio", "/case-studies"])(
    "classifies %s as WORK_INDEX",
    (path) => {
      expect(inferPageType(path)).toBe("WORK_INDEX");
    },
  );

  it("classifies a deeper path under a work-index root as PROJECT_DETAIL", () => {
    expect(inferPageType("/work/project-a")).toBe("PROJECT_DETAIL");
    expect(inferPageType("/projects/foo/bar")).toBe("PROJECT_DETAIL");
    expect(inferPageType("/case-studies/atlas")).toBe("PROJECT_DETAIL");
  });

  it.each(["/experience", "/resume", "/cv"])(
    "classifies %s as EXPERIENCE",
    (path) => {
      expect(inferPageType(path)).toBe("EXPERIENCE");
    },
  );

  it("classifies /education as EDUCATION", () => {
    expect(inferPageType("/education")).toBe("EDUCATION");
  });

  it.each(["/contact", "/hire-me", "/get-in-touch"])(
    "classifies %s as CONTACT",
    (path) => {
      expect(inferPageType(path)).toBe("CONTACT");
    },
  );

  it.each(["/blog", "/writing", "/posts"])(
    "classifies %s as BLOG",
    (path) => {
      expect(inferPageType(path)).toBe("BLOG");
    },
  );

  it("classifies a child of a blog root as BLOG", () => {
    expect(inferPageType("/blog/hello-world")).toBe("BLOG");
  });

  it("falls back to OTHER for an unrecognised path with no hints", () => {
    expect(inferPageType("/uses")).toBe("OTHER");
  });

  it("uses title/headings as a weak tiebreaker only for OTHER", () => {
    expect(
      inferPageType("/uses", { title: "Contact me anytime" }),
    ).toBe("CONTACT");
    expect(
      inferPageType("/uses", { headings: ["My Education"] }),
    ).toBe("EDUCATION");
  });

  it("does not let the tiebreaker override an already-classified route", () => {
    expect(inferPageType("/about", { title: "Contact" })).toBe("ABOUT");
  });
});

describe("summarizeRoutePatterns", () => {
  it("dedupes and sorts patterns with / first", () => {
    const result = summarizeRoutePatterns([
      "/about",
      "/work/project-a",
      "/",
      "/work/project-b",
      "/contact",
    ]);

    expect(result).toEqual(["/", "/about", "/contact", "/work/*"]);
  });

  it("returns an empty array for no input", () => {
    expect(summarizeRoutePatterns([])).toEqual([]);
  });
});
