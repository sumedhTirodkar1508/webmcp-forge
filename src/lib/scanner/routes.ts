/**
 * Deterministic route-shape and page-type inference from a pathname alone.
 *
 * No network, no DOM — these are pure string classifiers so they can run
 * both while extracting a page and while summarising a whole site's routes.
 */

import type { PageTypeId } from "@/lib/scanner/types";

function splitSegments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Collapses a pathname to its route shape: the first segment is kept
 * literal (lowercased), every segment after it becomes a wildcard star.
 * E.g. `/work/project-a` shapes to two segments, `work` and a wildcard.
 */
export function inferRoutePattern(pathname: string): string {
  const segments = splitSegments(pathname).map((segment) =>
    segment.toLowerCase(),
  );
  if (segments.length === 0) return "/";
  const shaped = segments.map((segment, index) =>
    index === 0 ? segment : "*",
  );
  return `/${shaped.join("/")}`;
}

const ABOUT_PATHS = new Set(["about", "about-me", "bio", "info"]);
const WORK_INDEX_PATHS = new Set([
  "work",
  "projects",
  "portfolio",
  "case-studies",
]);
const EXPERIENCE_PATHS = new Set(["experience", "resume", "cv"]);
const EDUCATION_PATHS = new Set(["education"]);
const CONTACT_PATHS = new Set(["contact", "hire-me", "get-in-touch"]);
const BLOG_PATHS = new Set(["blog", "writing", "posts"]);

function weakTiebreak(opts?: {
  title?: string;
  headings?: string[];
}): PageTypeId | undefined {
  const text = [opts?.title, ...(opts?.headings ?? [])]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  if (!text) return undefined;

  if (/\b(contact|hire me|get in touch)\b/.test(text)) return "CONTACT";
  if (/\b(experience|resume|cv)\b/.test(text)) return "EXPERIENCE";
  if (/\beducation\b/.test(text)) return "EDUCATION";
  if (/\b(blog|writing|posts?|articles?)\b/.test(text)) return "BLOG";
  if (/\b(projects?|portfolio|work|case studies)\b/.test(text)) {
    return "WORK_INDEX";
  }
  if (/\babout\b/.test(text)) return "ABOUT";
  return undefined;
}

export function inferPageType(
  pathname: string,
  opts?: { title?: string; headings?: string[] },
): PageTypeId {
  const segments = splitSegments(pathname).map((segment) =>
    segment.toLowerCase(),
  );

  if (segments.length === 0) return "HOME";

  const first = segments[0];

  if (WORK_INDEX_PATHS.has(first)) {
    return segments.length === 1 ? "WORK_INDEX" : "PROJECT_DETAIL";
  }
  if (BLOG_PATHS.has(first)) return "BLOG";
  if (segments.length === 1) {
    if (ABOUT_PATHS.has(first)) return "ABOUT";
    if (EXPERIENCE_PATHS.has(first)) return "EXPERIENCE";
    if (EDUCATION_PATHS.has(first)) return "EDUCATION";
    if (CONTACT_PATHS.has(first)) return "CONTACT";
  }

  return weakTiebreak(opts) ?? "OTHER";
}

/** Dedupe + sort inferred route patterns, `/` always first. */
export function summarizeRoutePatterns(pathnames: string[]): string[] {
  const patterns = new Set(pathnames.map((pathname) => inferRoutePattern(pathname)));
  return [...patterns].sort((a, b) => {
    if (a === b) return 0;
    if (a === "/") return -1;
    if (b === "/") return 1;
    return a.localeCompare(b);
  });
}
