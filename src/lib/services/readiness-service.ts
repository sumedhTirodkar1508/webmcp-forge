import "server-only";

import type { Site } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { describeCapabilities, loadCurrentSettings } from "@/lib/services/config-service";
import { getLatestScan } from "@/lib/services/scan-service";
import { getVerificationState } from "@/lib/services/verification-service";

/**
 * The readiness snapshot.
 *
 * This is the ONLY thing the readiness assistant is allowed to answer from. It
 * is assembled server-side from data WebMCP Forge already holds — scan results,
 * the published configuration, and the last verification report — so an answer
 * can always be traced back to something that was actually observed.
 *
 * Two things it is deliberately not:
 *
 *   - It is not the portfolio's content. There is no page HTML here and none is
 *     ever sent to Gemini. Content questions need a real tool call, which is
 *     what the live agent test is for.
 *   - It is not unbounded. Every list is capped, so a large site cannot inflate
 *     the prompt.
 */

/** Caps that keep the prompt small regardless of site size. */
const MAX_TOOL_NAMES = 20;
const MAX_WARNINGS = 5;
const MAX_DIAGNOSTICS = 12;

export interface ToolRegistrySnapshot {
  /** Tools the portfolio already exposed before Forge ran. */
  existingTools: string[];
  /** Generated names that collided with those, and were left untouched. */
  conflictingTools: string[];
  /** Tools Forge actually registered. */
  forgeRegistered: string[];
  /** Names the browser reported as visible after registration. */
  visibleToBrowser: string[];
  /** Genuine registration failures, as opposed to deliberate skips. */
  failures: Array<{ name: string; message: string }>;
}

export interface ReadinessSnapshot {
  site: {
    url: string | null;
    title: string | null;
    status: string;
    platform: string | null;
  };
  scan: {
    hasScanned: boolean;
    scannedAt: string | null;
    pagesScanned: number;
    /** Friendly-labelled counts, e.g. `{ Projects: 4, Skills: 43 }`. */
    found: Record<string, number>;
    missing: string[];
    warnings: string[];
    clientRendered: boolean;
    aiModel: string | null;
    aiFellBack: boolean;
  };
  capabilities: {
    enabled: string[];
    disabled: string[];
    unsupported: string[];
    contactSendEnabled: boolean;
  };
  contactForm: {
    detected: boolean;
    support: string | null;
    reasons: string[];
  };
  configuration: {
    publishedVersion: number | null;
    publishedAt: string | null;
    /** True when the site was re-scanned after the published config was made. */
    stale: boolean;
  };
  verification: {
    hasVerified: boolean;
    status: string;
    checkedAt: string | null;
    runtimeVersion: string | null;
    configVersion: number | null;
    webmcpAvailable: boolean;
    toolsRegistered: number;
    toolRegistry: ToolRegistrySnapshot | null;
    liveCounts: Record<string, number>;
    brokenMappings: string[];
    diagnostics: Array<{ label: string; status: string; detail?: string }>;
    changes: Array<{ key: string; previous: number; current: number; kind: string }>;
  };
  liveTest: {
    /** Whether a live WebMCP test session is currently connected. */
    connected: boolean;
    availableTools: string[];
  };
  demo: {
    questionsRemaining: number;
  };
}

function asToolRegistry(value: unknown): ToolRegistrySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const list = (key: string): string[] =>
    Array.isArray(raw[key])
      ? (raw[key] as unknown[]).filter((v): v is string => typeof v === "string").slice(0, MAX_TOOL_NAMES)
      : [];

  const failures = Array.isArray(raw.failures)
    ? (raw.failures as unknown[])
        .filter((f): f is { name: string; message: string } => {
          if (!f || typeof f !== "object") return false;
          const entry = f as Record<string, unknown>;
          return typeof entry.name === "string" && typeof entry.message === "string";
        })
        .slice(0, MAX_TOOL_NAMES)
    : [];

  return {
    existingTools: list("existingTools"),
    conflictingTools: list("conflictingTools"),
    forgeRegistered: list("forgeRegistered"),
    visibleToBrowser: list("visibleToBrowser"),
    failures,
  };
}

export async function buildReadinessSnapshot(
  site: Site,
  /** Whose live test to report. Another visitor's connected tab is not visible. */
  builderSessionId: string,
): Promise<ReadinessSnapshot> {
  const [scan, current, verification, latestRun, publishedVersion, liveSession, demoUsed] =
    await Promise.all([
      getLatestScan(site.id),
      loadCurrentSettings(site),
      getVerificationState(site.id),
      prisma.verificationRun.findFirst({
        where: { siteId: site.id },
        orderBy: { createdAt: "desc" },
        select: { toolRegistry: true },
      }),
      prisma.configVersion.findFirst({
        where: { siteId: site.id },
        orderBy: { version: "desc" },
        select: { version: true, publishedAt: true },
      }),
      prisma.liveTestSession.findFirst({
        where: {
          siteId: site.id,
          createdBySessionId: builderSessionId,
          status: "READY",
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
        select: { availableTools: true },
      }),
      prisma.aiUsageEvent.count({
        where: { siteId: site.id, purpose: "NL_DEMO", status: "SUCCESS", errorCode: null },
      }),
    ]);

  const capabilities = current ? describeCapabilities(current.mapping, current.settings) : [];
  const contactForm = current?.mapping.contactForm;

  const deterministic = (scan?.deterministic ?? {}) as Record<string, unknown>;
  const semantic = (scan?.semantic ?? {}) as Record<string, unknown>;
  const availableData = Array.isArray(semantic.available) ? (semantic.available as string[]) : [];

  const found: Record<string, number> = {};
  const mapping = current?.mapping;
  if (mapping) {
    if (mapping.projects?.expectedCount !== undefined) found.projects = mapping.projects.expectedCount;
    if (mapping.skills?.expectedNestedCount !== undefined) {
      found.skills = mapping.skills.expectedNestedCount;
      if (mapping.skills.expectedCount !== undefined) found.skillGroups = mapping.skills.expectedCount;
    } else if (mapping.skills?.expectedCount !== undefined) {
      found.skills = mapping.skills.expectedCount;
    }
    if (mapping.experience?.expectedCount !== undefined) found.experience = mapping.experience.expectedCount;
    if (mapping.education?.expectedCount !== undefined) found.education = mapping.education.expectedCount;
  }

  // A published config made before the newest scan describes older structure.
  const stale = Boolean(
    publishedVersion?.publishedAt &&
      scan?.finishedAt &&
      scan.finishedAt.getTime() > publishedVersion.publishedAt.getTime(),
  );

  const brokenMappings = Object.entries(verification?.liveCounts ?? {})
    .filter(([, count]) => count === 0)
    .map(([key]) => key);

  const liveTools = Array.isArray(liveSession?.availableTools)
    ? (liveSession.availableTools as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  return {
    site: {
      url: site.canonicalUrl,
      title: site.title,
      status: site.status,
      platform: site.platform,
    },
    scan: {
      hasScanned: Boolean(scan),
      scannedAt: scan?.finishedAt?.toISOString() ?? null,
      pagesScanned: scan?.pagesScanned ?? 0,
      found,
      missing: ["profile", "projects", "skills", "experience", "education", "contact"].filter(
        (key) => !availableData.includes(key),
      ),
      warnings: (Array.isArray(scan?.warnings) ? (scan.warnings as string[]) : []).slice(
        0,
        MAX_WARNINGS,
      ),
      clientRendered: deterministic.lowInformation === true,
      aiModel: scan?.semanticModel ?? null,
      aiFellBack: scan?.semanticFellBack ?? false,
    },
    capabilities: {
      enabled: capabilities.filter((c) => c.enabled).map((c) => c.toolName),
      disabled: capabilities.filter((c) => !c.enabled && c.supported).map((c) => c.toolName),
      unsupported: capabilities.filter((c) => !c.supported).map((c) => c.toolName),
      contactSendEnabled: capabilities.some(
        (c) => c.toolName === "send_contact_message" && c.enabled,
      ),
    },
    contactForm: {
      detected: Boolean(contactForm),
      support: contactForm?.support ?? null,
      reasons: contactForm?.reasons ?? [],
    },
    configuration: {
      publishedVersion: publishedVersion?.version ?? null,
      publishedAt: publishedVersion?.publishedAt?.toISOString() ?? null,
      stale,
    },
    verification: {
      hasVerified: Boolean(verification),
      status: verification?.status ?? "not_started",
      checkedAt: verification?.checkedAt ?? null,
      runtimeVersion: verification?.runtimeVersion ?? null,
      configVersion: verification?.configVersion ?? null,
      webmcpAvailable: verification?.webmcpAvailable ?? false,
      toolsRegistered: verification?.toolsRegistered ?? 0,
      toolRegistry: asToolRegistry(latestRun?.toolRegistry),
      liveCounts: verification?.liveCounts ?? {},
      brokenMappings,
      diagnostics: (verification?.diagnostics ?? [])
        .slice(0, MAX_DIAGNOSTICS)
        .map((d) => ({ label: d.label, status: d.status, detail: d.detail })),
      changes: verification?.changes ?? [],
    },
    liveTest: {
      connected: Boolean(liveSession),
      availableTools: liveTools.slice(0, MAX_TOOL_NAMES),
    },
    demo: {
      // Read from the single authoritative limit, not a literal.
      questionsRemaining: Math.max(0, getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS - demoUsed),
    },
  };
}
