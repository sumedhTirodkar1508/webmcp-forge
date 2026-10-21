import "server-only";

import type { Site } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { loadCurrentSettings, describeCapabilities } from "@/lib/services/config-service";

/**
 * Operational insights for the site's own owner.
 *
 * Deliberately NOT analytics. There is no visitor tracking here of any kind:
 * no IP addresses, no geolocation, no fingerprints, no visitor identifiers, and
 * no telemetry from ordinary WebMCP tool calls — those stay entirely inside the
 * visitor's browser and are never reported anywhere.
 *
 * Everything below is data WebMCP Forge already generated while the OWNER was
 * operating it: their own scans, their own verification checks, their own AI
 * questions. Nothing new is collected to build this panel.
 */

export interface InsightsSummary {
  scans: {
    total: number;
    lastDurationMs: number | null;
    lastModel: string | null;
    lastFellBack: boolean;
    pagesScanned: number;
    counts: Record<string, number>;
  };
  verification: {
    total: number;
    lastStatus: string | null;
    lastCheckedAt: string | null;
    runtimeVersion: string | null;
    configVersion: number | null;
    webmcpAvailable: boolean;
    nativeToolCount: number;
    conflictCount: number;
    forgeAddedCount: number;
    liveCounts: Record<string, number>;
  };
  ai: {
    questionsUsed: number;
    questionsRemaining: number;
    lastModel: string | null;
    lastFellBack: boolean;
    lastLatencyMs: number | null;
  };
  contact: {
    formDetected: boolean;
    support: string | null;
    sendEnabled: boolean;
  };
}

export async function buildInsights(site: Site): Promise<InsightsSummary> {
  const [scanCount, lastScan, verificationCount, lastRun, aiRows, current] = await Promise.all([
    prisma.scanRun.count({ where: { siteId: site.id } }),
    prisma.scanRun.findFirst({
      where: { siteId: site.id },
      orderBy: { startedAt: "desc" },
    }),
    prisma.verificationRun.count({ where: { siteId: site.id } }),
    prisma.verificationRun.findFirst({
      where: { siteId: site.id },
      orderBy: { createdAt: "desc" },
    }),
    prisma.aiUsageEvent.findMany({
      where: { siteId: site.id, purpose: "NL_DEMO" },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { status: true, errorCode: true, model: true, latencyMs: true },
    }),
    loadCurrentSettings(site),
  ]);

  const mapping = current?.mapping;
  const counts: Record<string, number> = {};
  if (mapping?.projects?.expectedCount !== undefined) counts.projects = mapping.projects.expectedCount;
  if (mapping?.skills?.expectedNestedCount !== undefined) {
    counts.skills = mapping.skills.expectedNestedCount;
    if (mapping.skills.expectedCount !== undefined) counts.skillGroups = mapping.skills.expectedCount;
  } else if (mapping?.skills?.expectedCount !== undefined) {
    counts.skills = mapping.skills.expectedCount;
  }
  if (mapping?.experience?.expectedCount !== undefined) counts.experience = mapping.experience.expectedCount;
  if (mapping?.education?.expectedCount !== undefined) counts.education = mapping.education.expectedCount;

  const registry = (lastRun?.toolRegistry ?? null) as {
    existingTools?: unknown;
    conflictingTools?: unknown;
    forgeRegistered?: unknown;
  } | null;
  const size = (value: unknown) => (Array.isArray(value) ? value.length : 0);

  // A question is one SUCCESS row with no errorCode; `summarize` rows belong to
  // the same submission and retries were never successes.
  const questionsUsed = aiRows.filter(
    (row) => row.status === "SUCCESS" && row.errorCode === null,
  ).length;
  const lastSuccess = aiRows.find((row) => row.status === "SUCCESS");

  const capabilities = current ? describeCapabilities(current.mapping, current.settings) : [];

  return {
    scans: {
      total: scanCount,
      lastDurationMs:
        lastScan?.finishedAt && lastScan.startedAt
          ? lastScan.finishedAt.getTime() - lastScan.startedAt.getTime()
          : null,
      lastModel: lastScan?.semanticModel ?? null,
      lastFellBack: lastScan?.semanticFellBack ?? false,
      pagesScanned: lastScan?.pagesScanned ?? 0,
      counts,
    },
    verification: {
      total: verificationCount,
      lastStatus: lastRun?.outcome ?? null,
      lastCheckedAt: lastRun?.createdAt.toISOString() ?? null,
      runtimeVersion: lastRun?.runtimeVersion ?? null,
      configVersion: null,
      webmcpAvailable: lastRun?.webmcpAvailable ?? false,
      nativeToolCount: size(registry?.existingTools),
      conflictCount: size(registry?.conflictingTools),
      forgeAddedCount: size(registry?.forgeRegistered),
      liveCounts: (lastRun?.liveCounts ?? {}) as Record<string, number>,
    },
    ai: {
      questionsUsed,
      // The limit has exactly one source of truth: the environment.
      questionsRemaining: Math.max(
        0,
        getEnv().GEMINI_NL_DEMO_MAX_QUESTIONS - questionsUsed,
      ),
      lastModel: lastSuccess?.model ?? null,
      // Compared against the configured primary rather than guessed from the
      // model name, which broke silently whenever model ids changed.
      lastFellBack: Boolean(
        lastSuccess && lastSuccess.model !== getEnv().GEMINI_NL_DEMO_PRIMARY_MODEL,
      ),
      lastLatencyMs: lastSuccess?.latencyMs ?? null,
    },
    contact: {
      formDetected: Boolean(mapping?.contactForm),
      support: mapping?.contactForm?.support ?? null,
      sendEnabled: capabilities.some((c) => c.toolName === "send_contact_message" && c.enabled),
    },
  };
}
