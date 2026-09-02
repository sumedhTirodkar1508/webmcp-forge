import "server-only";

import type { BuilderSession, VerificationRun } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { asJson } from "@/lib/json";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken } from "@/lib/tokens";
import type {
  VerificationDiagnostic,
  VerificationState,
} from "@/lib/services/types";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * Real installation verification.
 *
 * A database flag proves nothing. The only evidence that counts is the runtime
 * on the actual portfolio reporting back, so:
 *
 *   1. the builder mints a single-use challenge and stores only its hash;
 *   2. the owner's portfolio is opened with the raw challenge in the URL;
 *   3. the installed runtime reports diagnostics to a narrow public endpoint;
 *   4. that endpoint checks the hash, the expiry, the public site id and the
 *      browser-asserted Origin, then consumes the challenge atomically.
 *
 * Replay is impossible because consumption is a conditional update: the first
 * report wins and every later one finds `consumedAt` already set.
 */

export interface ChallengeIssue {
  /** The raw challenge. Returned once, to be placed in the verification URL. */
  challenge: string;
  verifyUrl: string;
  expiresAt: Date;
}

export async function createVerificationChallenge(
  session: BuilderSession,
  siteId: string,
): Promise<ChallengeIssue> {
  const site = await requireOwnedSiteFor(session, siteId);

  if (!site.publishedConfigVersionId) {
    throw new AppError(
      "NO_PUBLISHED_CONFIG",
      "Generate your installation snippet before checking the installation.",
    );
  }

  const ttlSeconds = getEnv().VERIFICATION_CHALLENGE_TTL_SECONDS;
  const challenge = generateToken();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await prisma.verificationChallenge.create({
    data: {
      siteId: site.id,
      challengeHash: hashToken(challenge),
      expectedOrigin: site.origin,
      expiresAt,
    },
  });

  const verifyUrl = new URL(site.canonicalUrl);
  verifyUrl.searchParams.set("__wmf_verify", challenge);

  return { challenge, verifyUrl: verifyUrl.toString(), expiresAt };
}

/** What the installed runtime posts back. Already schema-validated by the route. */
export interface VerificationReport {
  siteId: string;
  challenge: string;
  runtimeVersion: string;
  configVersion: number;
  path: string;
  webmcpAvailable: boolean;
  webmcpReason: string | null;
  toolsRegistered: number;
  toolNames: string[];
  toolsVisibleToBrowser: string[];
  toolRegistrationFailures: Array<{ name: string; message: string }>;
  liveCounts: Record<string, number>;
  mappingHealth: Record<string, boolean>;
}

/**
 * Validates and records a verification report.
 *
 * `requestOrigin` is the browser-asserted `Origin` header on the cross-origin
 * POST. The browser sets it and page script cannot forge it, which is what makes
 * it worth checking: it proves the report came from a page actually served by
 * the portfolio's own origin.
 */
export async function recordVerification(
  report: VerificationReport,
  requestOrigin: string | null,
): Promise<VerificationRun> {
  const challengeHash = hashToken(report.challenge);

  const challenge = await prisma.verificationChallenge.findUnique({
    where: { challengeHash },
    include: { site: true },
  });

  if (!challenge) {
    throw new AppError("VERIFICATION_EXPIRED", "That verification link is no longer valid.");
  }
  if (challenge.consumedAt) {
    throw new AppError("VERIFICATION_CONSUMED", "That verification link has already been used.");
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new AppError("VERIFICATION_EXPIRED", "That verification link has expired.");
  }
  if (challenge.site.publicId !== report.siteId) {
    throw new AppError("VERIFICATION_SITE_MISMATCH", "That report is for a different site.");
  }
  if (!requestOrigin || requestOrigin !== challenge.expectedOrigin) {
    logger.warn("verification_origin_mismatch", { siteId: challenge.siteId });
    throw new AppError(
      "VERIFICATION_ORIGIN_MISMATCH",
      "That report did not come from the website we expected.",
    );
  }

  // Atomic consumption. A concurrent replay updates zero rows and is rejected.
  const consumed = await prisma.verificationChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new AppError("VERIFICATION_CONSUMED", "That verification link has already been used.");
  }

  const publishedVersion = challenge.site.publishedConfigVersionId
    ? await prisma.configVersion.findUnique({
        where: { id: challenge.site.publishedConfigVersionId },
        select: { id: true, version: true },
      })
    : null;

  const diagnostics = buildDiagnostics(report, publishedVersion?.version ?? null);
  const outcome = diagnostics.some((d) => d.status === "fail")
    ? "FAILED"
    : diagnostics.some((d) => d.status === "warn")
      ? "PARTIAL"
      : "SUCCESS";

  return prisma.verificationRun.create({
    data: {
      siteId: challenge.siteId,
      challengeId: challenge.id,
      configVersionId: publishedVersion?.id ?? null,
      runtimeVersion: report.runtimeVersion,
      reportedOrigin: requestOrigin,
      reportedPath: report.path,
      webmcpAvailable: report.webmcpAvailable,
      toolsRegistered: report.toolsRegistered,
      liveCounts: asJson(report.liveCounts),
      diagnostics: asJson(diagnostics),
      outcome,
    },
  });
}

function buildDiagnostics(
  report: VerificationReport,
  expectedConfigVersion: number | null,
): VerificationDiagnostic[] {
  const diagnostics: VerificationDiagnostic[] = [
    {
      id: "runtime",
      label: "Agent runtime installed",
      status: "pass",
      detail: `version ${report.runtimeVersion}`,
    },
  ];

  diagnostics.push(
    expectedConfigVersion === null || report.configVersion === expectedConfigVersion
      ? {
          id: "config",
          label: "Configuration loaded",
          status: "pass",
          detail: `version ${report.configVersion}`,
        }
      : {
          id: "config",
          label: "Configuration loaded",
          status: "warn",
          detail: `the page is using version ${report.configVersion}; the current version is ${expectedConfigVersion}. It may still be cached.`,
        },
  );

  const mappingEntries = Object.entries(report.mappingHealth);
  const brokenMappings = mappingEntries.filter(([, healthy]) => !healthy).map(([id]) => id);
  diagnostics.push(
    mappingEntries.length === 0
      ? { id: "mappings", label: "Live content mappings", status: "warn", detail: "nothing to check" }
      : brokenMappings.length === 0
        ? { id: "mappings", label: "Live content mappings", status: "pass" }
        : {
            id: "mappings",
            label: "Live content mappings",
            status: "fail",
            detail: `no longer matching: ${brokenMappings.join(", ")}`,
          },
  );

  diagnostics.push(
    report.webmcpAvailable
      ? { id: "webmcp", label: "WebMCP available in this browser", status: "pass" }
      : {
          id: "webmcp",
          label: "WebMCP available in this browser",
          // A warning, not a failure: the installation is correct, the browser
          // simply does not implement the API yet.
          status: "warn",
          detail:
            report.webmcpReason === "insecure_context"
              ? "the page must be served over HTTPS"
              : "this browser does not support document.modelContext yet",
        },
  );

  diagnostics.push(
    report.toolsRegistered > 0
      ? {
          id: "tools",
          label: `${report.toolsRegistered} agent tool${report.toolsRegistered === 1 ? "" : "s"} registered`,
          status: "pass",
          detail: report.toolNames.join(", "),
        }
      : {
          id: "tools",
          label: "Agent tools registered",
          status: report.webmcpAvailable ? "fail" : "warn",
          detail: report.webmcpAvailable
            ? "the runtime loaded but registered nothing"
            : "tools register once your browser supports WebMCP",
        },
  );

  for (const [key, count] of Object.entries(report.liveCounts)) {
    diagnostics.push({
      id: `count_${key}`,
      label: `${count} ${key} found on the page`,
      status: count > 0 ? "pass" : "fail",
      detail: count === 0 ? "the saved mapping matched nothing" : undefined,
    });
  }

  return diagnostics;
}

/**
 * The current verification state, including on-demand change detection.
 *
 * Change detection is a comparison between the last two verification runs —
 * there is no cron job, no monitoring service and no email. Adding a project
 * shows as growth; a selector that stops matching shows as broken.
 */
export async function getVerificationState(siteId: string): Promise<VerificationState | null> {
  const runs = await prisma.verificationRun.findMany({
    where: { siteId },
    orderBy: { createdAt: "desc" },
    take: 2,
    include: {
      configVersion: { select: { version: true } },
    },
  });

  const [latest, previous] = runs;
  if (!latest) return null;

  const liveCounts = (latest.liveCounts ?? {}) as Record<string, number>;
  const previousCounts = (previous?.liveCounts ?? {}) as Record<string, number>;

  const changes: VerificationState["changes"] = [];
  for (const [key, current] of Object.entries(liveCounts)) {
    const before = previousCounts[key];
    if (before === undefined || before === current) continue;
    changes.push({
      key,
      previous: before,
      current,
      kind: current === 0 ? "broken" : current > before ? "grew" : "shrank",
    });
  }

  return {
    status:
      latest.outcome === "SUCCESS"
        ? "success"
        : latest.outcome === "PARTIAL"
          ? "partial"
          : "failed",
    checkedAt: latest.createdAt.toISOString(),
    runtimeVersion: latest.runtimeVersion,
    configVersion: latest.configVersion?.version ?? null,
    webmcpAvailable: latest.webmcpAvailable,
    toolsRegistered: latest.toolsRegistered,
    diagnostics: (latest.diagnostics ?? []) as unknown as VerificationDiagnostic[],
    liveCounts,
    changes,
  };
}
