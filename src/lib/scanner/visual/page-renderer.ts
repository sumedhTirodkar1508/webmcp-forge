import "server-only";

import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { AmbiguousSection } from "@/lib/scanner/visual/ambiguity";

/**
 * The page-renderer abstraction for visual scan assistance.
 *
 * ## Why there is no production implementation
 *
 * Screenshots would genuinely help disambiguate a structurally-valid but
 * semantically unclear page. The blocker is not capability, it is containment.
 *
 * The fetch-based scanner is safe because we control every request: each URL is
 * validated, each redirect hop is re-validated, and the connection itself
 * resolves through a DNS lookup that refuses private addresses. **None of that
 * transfers to a browser process.** A headless browser performs its own DNS,
 * follows its own redirects, and — critically — loads whatever subresources the
 * page asks for: scripts, iframes, fonts, XHR to any origin it likes. A
 * portfolio that embeds `http://169.254.169.254/latest/meta-data/` in an iframe
 * would have that fetched by the browser, not by us, entirely outside the
 * deny-list.
 *
 * Making that safe needs containment at the network layer, not the application
 * layer: every request the browser makes forced through a proxy that enforces
 * the same IP rules, or a network namespace with no route to private space.
 * Neither is something to improvise on Vercel's serverless runtime, and getting
 * it subtly wrong turns the scanner into exactly the SSRF proxy the rest of the
 * codebase works hard to prevent.
 *
 * So: the abstraction, the selection logic, the image bounds and the failure
 * behaviour are all implemented and tested here, and `VISUAL_SCAN_ENABLED`
 * defaults to false with no renderer registered. A local or self-hosted
 * deployment that HAS contained a browser can register one through
 * `setPageRenderer`. Nothing about the normal scan path changes.
 */

export const SUPPORTED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];

export interface CapturedImage {
  mimeType: SupportedImageMime;
  /** Raw image bytes. Never written to disk or a database. */
  data: Uint8Array;
  /** Which ambiguity this was captured for, for the prompt's benefit. */
  section: string;
  pageUrl: string;
}

export interface CaptureRequest {
  pageUrl: string;
  section: AmbiguousSection;
  /** Viewport width to render at. */
  width: number;
  /** Maximum crop height. */
  maxHeight: number;
}

/**
 * A renderer capable of screenshotting a public page.
 *
 * An implementation MUST contain the browser's network access itself; this
 * interface cannot enforce it.
 */
export interface PageRenderer {
  readonly name: string;
  capture(request: CaptureRequest): Promise<CapturedImage | null>;
  close?(): Promise<void>;
}

let registered: PageRenderer | null = null;

/** Registers a contained renderer. Intended for local/experimental use. */
export function setPageRenderer(renderer: PageRenderer | null): void {
  registered = renderer;
}

export function getPageRenderer(): PageRenderer | null {
  return registered;
}

/** Whether visual assistance may run at all. */
export function visualScanAvailable(): boolean {
  return getEnv().VISUAL_SCAN_ENABLED && registered !== null;
}

export interface ImageBounds {
  maxImages: number;
  maxBytesPerImage: number;
  maxTotalBytes: number;
}

export function imageBounds(): ImageBounds {
  const env = getEnv();
  return {
    maxImages: env.VISUAL_SCAN_MAX_IMAGES,
    maxBytesPerImage: env.VISUAL_SCAN_MAX_IMAGE_BYTES,
    maxTotalBytes: env.VISUAL_SCAN_MAX_TOTAL_IMAGE_BYTES,
  };
}

export type ImageRejection = "unsupported_mime" | "too_large" | "too_many" | "total_too_large";

export interface BoundedImages {
  accepted: CapturedImage[];
  rejected: Array<{ section: string; reason: ImageRejection }>;
}

/**
 * Enforces our own limits before anything reaches the provider.
 *
 * Deliberately not left to Gemini's upstream limits: an oversized or
 * unsupported payload should be refused here, where the behaviour is
 * predictable and testable.
 */
export function enforceImageBounds(
  images: CapturedImage[],
  bounds: ImageBounds = imageBounds(),
): BoundedImages {
  const accepted: CapturedImage[] = [];
  const rejected: BoundedImages["rejected"] = [];
  let total = 0;

  for (const image of images) {
    if (!SUPPORTED_IMAGE_MIME.includes(image.mimeType)) {
      rejected.push({ section: image.section, reason: "unsupported_mime" });
      continue;
    }
    if (image.data.byteLength > bounds.maxBytesPerImage) {
      rejected.push({ section: image.section, reason: "too_large" });
      continue;
    }
    if (accepted.length >= bounds.maxImages) {
      rejected.push({ section: image.section, reason: "too_many" });
      continue;
    }
    if (total + image.data.byteLength > bounds.maxTotalBytes) {
      rejected.push({ section: image.section, reason: "total_too_large" });
      continue;
    }

    accepted.push(image);
    total += image.data.byteLength;
  }

  return { accepted, rejected };
}

/** Render geometry: wide enough to read, cropped rather than full-page. */
const CAPTURE_WIDTH = 1280;
const CAPTURE_MAX_HEIGHT = 1200;

export interface VisualAssistResult {
  images: CapturedImage[];
  /** Bounded, user-presentable notes. Never a stack trace. */
  warnings: string[];
}

/**
 * Captures screenshots for the most ambiguous sections, if that is possible.
 *
 * Never throws: visual assistance is an optional enhancement, and a scan whose
 * deterministic extraction already worked must not fail because a browser did.
 */
export async function captureForAmbiguity(
  sections: AmbiguousSection[],
): Promise<VisualAssistResult> {
  const renderer = getPageRenderer();
  if (!renderer || !visualScanAvailable()) {
    return { images: [], warnings: [] };
  }

  const bounds = imageBounds();
  if (bounds.maxImages === 0) return { images: [], warnings: [] };

  const captured: CapturedImage[] = [];
  const warnings: string[] = [];

  // Highest-priority sections only, and never more than the cap.
  for (const section of sections.slice(0, bounds.maxImages)) {
    try {
      const image = await renderer.capture({
        pageUrl: section.pageUrl,
        section,
        width: CAPTURE_WIDTH,
        maxHeight: CAPTURE_MAX_HEIGHT,
      });
      if (image) captured.push(image);
    } catch (error) {
      logger.warn("visual_capture_failed", {
        section: section.section,
        renderer: renderer.name,
        message: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const bounded = enforceImageBounds(captured, bounds);
  if (bounded.rejected.length > 0) {
    warnings.push("Some visual assistance images were skipped because they exceeded our limits.");
  }
  if (captured.length === 0 && sections.length > 0) {
    warnings.push("Visual assistance was unavailable; structural scan continued.");
  }

  return { images: bounded.accepted, warnings };
}
