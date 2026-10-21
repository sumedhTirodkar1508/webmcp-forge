import type { CapabilityId } from "@/lib/capabilities/catalogue";
import type { PlatformId } from "@/lib/scanner/types";

/**
 * The builder state DTO.
 *
 * One shape, serialised once, consumed by both the React UI and the WebMCP
 * builder tools. That is deliberate: §27 of the architecture requires that a
 * tool call and a button click go through the same code, so an agent driving
 * the builder cannot end up looking at different state from the person watching
 * the screen.
 *
 * Everything here is safe to send to the browser. No database ids beyond the
 * site's own, no session token, no scan internals, no AI accounting.
 */

export type SiteStatusId = "DRAFT" | "SCANNED" | "CONFIGURED" | "PUBLISHED";

export interface CapabilityState {
  id: CapabilityId;
  label: string;
  description: string;
  /** The generic WebMCP tool name — shown only under "advanced". */
  toolName: string;
  enabled: boolean;
  /** False when the scan found no data this capability could use. */
  supported: boolean;
  readOnly: boolean;
}

export interface DiscoverySummary {
  platform: PlatformId;
  platformConfidence: number;
  pagesScanned: number;
  routePatterns: string[];
  /** What was found, in plain terms: `{ projects: 7, skills: 12 }`. */
  found: Record<string, number>;
  /** Sections the scan could not find. */
  missing: string[];
  warnings: string[];
  /** True when the site appeared to render its content client-side. */
  lowInformation: boolean;
  usedAi: boolean;
  aiModel: string | null;
  aiFellBack: boolean;
  scannedAt: string | null;
  /**
   * A WebMCP Forge snippet found in the site's HTML, if any.
   *
   * `matchesThisSite` is false when the snippet names a DIFFERENT site id —
   * typically a snippet copied from another site or an old test. Surfacing
   * that tells the owner exactly why their site isn't reporting back, instead
   * of leaving them to guess.
   */
  installedSnippet: {
    siteId: string;
    configVersion: number | null;
    matchesThisSite: boolean;
  } | null;
}

export interface InstallationState {
  /** The public site id embedded in the snippet. Permanent. */
  publicId: string;
  /** Snippet pinning `latestGeneratedVersion`, ready to paste. */
  scriptTag: string;
  runtimeUrl: string;
  platform: PlatformId;
  /** The newest version generated in Forge. NOT necessarily what is live. */
  latestGeneratedVersion: number;
  generatedAt: string | null;
  /**
   * The version the live website actually pins, when a scan could read
   * `data-wmf-config` from its HTML. Null when unknown or not installed.
   */
  installedVersion: number | null;
  /** A newer successful scan exists than the latest generated configuration. */
  needsRegeneration?: boolean;
}

export interface VerificationDiagnostic {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "unknown";
  detail?: string;
}

export interface VerificationState {
  status: "not_started" | "pending" | "success" | "partial" | "failed";
  checkedAt: string | null;
  runtimeVersion: string | null;
  configVersion: number | null;
  webmcpAvailable: boolean;
  toolsRegistered: number;
  diagnostics: VerificationDiagnostic[];
  liveCounts: Record<string, number>;
  /** Differences against the previous verification — on-demand change detection. */
  changes: Array<{ key: string; previous: number; current: number; kind: "grew" | "shrank" | "broken" }>;
}

export interface BuilderState {
  siteId: string | null;
  publicId: string | null;
  targetUrl: string | null;
  origin: string | null;
  title: string | null;
  status: SiteStatusId;
  discovery: DiscoverySummary | null;
  capabilities: CapabilityState[];
  installation: InstallationState | null;
  verification: VerificationState | null;
  /** Remaining natural-language demo questions, enforced server-side. */
  demoQuestionsRemaining: number;
}

export const EMPTY_BUILDER_STATE: BuilderState = {
  siteId: null,
  publicId: null,
  targetUrl: null,
  origin: null,
  title: null,
  status: "DRAFT",
  discovery: null,
  capabilities: [],
  installation: null,
  verification: null,
  demoQuestionsRemaining: 0,
};
