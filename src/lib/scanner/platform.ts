/**
 * Deterministic platform fingerprinting.
 *
 * Looks for well-known signatures left by page builders (Framer, Wix,
 * Webflow, Squarespace) and frameworks (Next.js) in server-rendered HTML.
 * Falls back to CUSTOM when the page clearly has real content but no known
 * signature matched, or UNKNOWN when there's nothing to go on at all.
 *
 * Every signal is evaluated independently and contributes evidence; the
 * platform with the most matching signals wins. Confidence is a simple
 * function of how many independent signals fired for the winning platform.
 */

import type { CheerioAPI } from "cheerio";

import type { PlatformFingerprint, PlatformId } from "@/lib/scanner/types";

const MAX_EVIDENCE = 8;

interface Signal {
  platform: Exclude<PlatformId, "CUSTOM" | "UNKNOWN">;
  /** Weight this signal contributes toward confidence. */
  weight: number;
  test: (html: string, $: CheerioAPI) => string | undefined;
}

/** Each `test` returns an evidence string when it matches, else undefined. */
const SIGNALS: Signal[] = [
  // Webflow
  {
    platform: "WEBFLOW",
    weight: 0.4,
    test: (_html, $) => {
      if ($("html[data-wf-page]").length > 0) return "html[data-wf-page]";
      if ($("html[data-wf-site]").length > 0) return "html[data-wf-site]";
      return undefined;
    },
  },
  {
    platform: "WEBFLOW",
    weight: 0.2,
    test: (_html, $) => {
      const hasWClass = $("[class*='w-']").filter((_i, el) => {
        const cls = $(el).attr("class") ?? "";
        return cls.split(/\s+/).some((c) => /^w-/.test(c));
      });
      return hasWClass.length > 0 ? "class^=w-" : undefined;
    },
  },
  {
    platform: "WEBFLOW",
    weight: 0.3,
    test: (html) => {
      if (html.includes("assets.website-files.com")) {
        return "assets.website-files.com";
      }
      if (html.includes("uploads-ssl.webflow.com")) {
        return "uploads-ssl.webflow.com";
      }
      return undefined;
    },
  },
  // Framer
  {
    platform: "FRAMER",
    weight: 0.4,
    test: (html) =>
      html.includes("framerusercontent.com")
        ? "framerusercontent.com"
        : undefined,
  },
  {
    platform: "FRAMER",
    weight: 0.3,
    test: (_html, $) =>
      $("[data-framer-name]").length > 0 ? "data-framer-name" : undefined,
  },
  {
    platform: "FRAMER",
    weight: 0.3,
    test: (_html, $) =>
      $("#__framer-badge-container").length > 0
        ? "id=__framer-badge-container"
        : undefined,
  },
  {
    platform: "FRAMER",
    weight: 0.2,
    test: (_html, $) =>
      $("meta[name='framer-search-index']").length > 0
        ? "meta[name=framer-search-index]"
        : undefined,
  },
  // Wix
  {
    platform: "WIX",
    weight: 0.4,
    test: (html) =>
      html.includes("static.parastorage.com")
        ? "static.parastorage.com"
        : undefined,
  },
  {
    platform: "WIX",
    weight: 0.3,
    test: (_html, $) =>
      $("#SITE_CONTAINER").length > 0 ? "id=SITE_CONTAINER" : undefined,
  },
  {
    platform: "WIX",
    weight: 0.2,
    test: (html) => (html.includes("wix-") ? "wix- marker" : undefined),
  },
  // Squarespace
  {
    platform: "SQUARESPACE",
    weight: 0.4,
    test: (html) =>
      html.includes("static1.squarespace.com")
        ? "static1.squarespace.com"
        : undefined,
  },
  {
    platform: "SQUARESPACE",
    weight: 0.3,
    test: (html) =>
      html.includes("Static.SQUARESPACE_CONTEXT")
        ? "Static.SQUARESPACE_CONTEXT"
        : undefined,
  },
  // Next.js
  {
    platform: "NEXTJS",
    weight: 0.4,
    test: (_html, $) =>
      $("#__NEXT_DATA__").length > 0 ? "id=__NEXT_DATA__" : undefined,
  },
  {
    platform: "NEXTJS",
    weight: 0.3,
    test: (html) => (html.includes("/_next/static/") ? "/_next/static/" : undefined),
  },
];

function generatorSignal(
  $: CheerioAPI,
): { platform: Exclude<PlatformId, "CUSTOM" | "UNKNOWN">; evidence: string } | undefined {
  const content = $("meta[name='generator']").attr("content");
  if (!content) return undefined;
  const lower = content.toLowerCase();
  const evidence = `meta[name=generator]=${content.slice(0, 60)}`;
  if (lower.includes("framer")) return { platform: "FRAMER", evidence };
  if (lower.includes("wix")) return { platform: "WIX", evidence };
  if (lower.includes("webflow")) return { platform: "WEBFLOW", evidence };
  if (lower.includes("squarespace")) return { platform: "SQUARESPACE", evidence };
  if (lower.includes("next.js")) return { platform: "NEXTJS", evidence };
  return undefined;
}

function hasRealContent($: CheerioAPI): boolean {
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.length >= 100 || $("h1,h2,h3").length > 0;
}

/**
 * Hostname suffixes builders serve on before a custom domain is attached.
 *
 * These are all domains owned by the site BUILDER, so serving from one really
 * is evidence of how the site was made: a page on `framer.app` was built in
 * Framer.
 *
 * Generic hosting domains do not belong here. `vercel.app` was listed as
 * evidence of Next.js, but Vercel hosts anything — our own demo portfolio is
 * plain static HTML on `*.vercel.app` and was being reported as Next.js, which
 * then produced Next.js installation instructions for a site with no Next.js
 * in it. Next.js is now recognised only from real markup evidence
 * (`__NEXT_DATA__`, `/_next/static/`), which appears on a Vercel-hosted Next
 * site anyway.
 */
const HOSTNAME_SIGNALS: Array<
  [Exclude<PlatformId, "CUSTOM" | "UNKNOWN">, string[]]
> = [
  ["FRAMER", ["framer.app", "framer.website", "framer.media"]],
  ["WEBFLOW", ["webflow.io"]],
  ["WIX", ["wixsite.com", "editorx.io"]],
  ["SQUARESPACE", ["squarespace.com"]],
];

function hostnameSignal(
  url: string,
): { platform: Exclude<PlatformId, "CUSTOM" | "UNKNOWN">; evidence: string } | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [platform, suffixes] of HOSTNAME_SIGNALS) {
    for (const suffix of suffixes) {
      if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
        return { platform, evidence: `hostname~=${suffix}` };
      }
    }
  }
  return undefined;
}

export function fingerprintPlatform(
  html: string,
  $: CheerioAPI,
  url: string,
): PlatformFingerprint {
  const scores = new Map<
    Exclude<PlatformId, "CUSTOM" | "UNKNOWN">,
    { score: number; evidence: string[] }
  >();

  const bump = (
    platform: Exclude<PlatformId, "CUSTOM" | "UNKNOWN">,
    weight: number,
    evidence: string,
  ) => {
    const existing = scores.get(platform) ?? { score: 0, evidence: [] };
    existing.score += weight;
    existing.evidence.push(evidence);
    scores.set(platform, existing);
  };

  const generator = generatorSignal($);
  if (generator) {
    bump(generator.platform, 0.6, generator.evidence);
  }

  const hostname = hostnameSignal(url);
  if (hostname) {
    bump(hostname.platform, 0.3, hostname.evidence);
  }

  for (const signal of SIGNALS) {
    const evidence = signal.test(html, $);
    if (evidence) {
      bump(signal.platform, signal.weight, evidence);
    }
  }

  let winner: Exclude<PlatformId, "CUSTOM" | "UNKNOWN"> | undefined;
  let winnerScore = 0;
  let winnerEvidence: string[] = [];
  for (const [platform, { score, evidence }] of scores) {
    if (score > winnerScore) {
      winner = platform;
      winnerScore = score;
      winnerEvidence = evidence;
    }
  }

  if (winner) {
    return {
      platform: winner,
      confidence: Math.min(1, winnerScore),
      evidence: winnerEvidence.slice(0, MAX_EVIDENCE),
    };
  }

  if (hasRealContent($)) {
    return { platform: "CUSTOM", confidence: 0.3, evidence: [] };
  }

  return { platform: "UNKNOWN", confidence: 0, evidence: [] };
}

export function mergeFingerprints(
  fps: PlatformFingerprint[],
): PlatformFingerprint {
  if (fps.length === 0) {
    return { platform: "UNKNOWN", confidence: 0, evidence: [] };
  }

  let best: PlatformFingerprint | undefined;
  for (const fp of fps) {
    if (fp.platform === "UNKNOWN") continue;
    if (!best || fp.confidence > best.confidence) {
      best = fp;
    }
  }

  const winner = best ?? fps[0];

  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const fp of fps) {
    if (fp.platform !== winner.platform) continue;
    for (const e of fp.evidence) {
      if (!seen.has(e)) {
        seen.add(e);
        evidence.push(e);
      }
      if (evidence.length >= MAX_EVIDENCE) break;
    }
    if (evidence.length >= MAX_EVIDENCE) break;
  }

  return {
    platform: winner.platform,
    confidence: winner.confidence,
    evidence,
  };
}
