import "server-only";

import { siteMappingSchema, type SiteMapping } from "@/lib/ai/mapping-schema";
import { availableRequirements } from "@/lib/ai/resolve-mapping";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_LIST,
  type CapabilityId,
} from "@/lib/capabilities/catalogue";
import {
  enabledCapabilities,
  normalizeSettings,
  type CapabilitySettings,
} from "@/lib/capabilities/settings";
import type { BuilderSession, ConfigVersion, Site } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { asJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import {
  RUNTIME_SCHEMA_VERSION,
  runtimeConfigSchema,
  type RuntimeConfig,
} from "@/lib/runtime-config";
import { getLatestSuccessfulScan } from "@/lib/services/scan-service";
import type { CapabilityState } from "@/lib/services/types";
import { requireOwnedSiteFor } from "@/lib/session";

/**
 * Configuration: mapping + capability settings, versioned and published.
 *
 * Config versions are immutable. Publishing points the site at one of them;
 * editing a toggle and publishing again creates a new row rather than mutating
 * an old one. That means the runtime configuration a portfolio is serving is
 * always exactly the thing that was verified, and rolling back is a pointer
 * change rather than a reconstruction.
 */

interface ScanArtifacts {
  mapping: SiteMapping;
  settings: CapabilitySettings;
}

/** Reads the mapping and recommended settings out of the latest good scan. */
async function loadScanArtifacts(siteId: string): Promise<ScanArtifacts | null> {
  const scan = await getLatestSuccessfulScan(siteId);
  if (!scan?.semantic || typeof scan.semantic !== "object") return null;

  const payload = scan.semantic as Record<string, unknown>;
  const mapping = siteMappingSchema.safeParse(payload.mapping);
  if (!mapping.success) return null;

  const available = availableRequirements(mapping.data);
  return {
    mapping: mapping.data,
    settings: normalizeSettings(payload.settings, available),
  };
}

/**
 * The settings currently in force: whatever was last published, otherwise the
 * scan's recommendation.
 */
export async function loadCurrentSettings(
  site: Site,
): Promise<{ mapping: SiteMapping; settings: CapabilitySettings } | null> {
  const artifacts = await loadScanArtifacts(site.id);
  if (!artifacts) return null;

  const draft = await prisma.configVersion.findFirst({
    where: { siteId: site.id },
    orderBy: { version: "desc" },
  });

  if (!draft) return artifacts;

  const config = draft.runtimeConfig as Record<string, unknown>;
  const enabled = Array.isArray(config.enabledCapabilities)
    ? (config.enabledCapabilities as string[])
    : [];

  // The mapping always comes from the newest scan — a published config can be
  // older than the structure it describes.
  const settings: CapabilitySettings = {};
  for (const capability of CAPABILITY_LIST) {
    settings[capability.id] = enabled.includes(capability.id);
  }

  return { mapping: artifacts.mapping, settings };
}

/** Which capabilities the current mapping can actually support. */
export function describeCapabilities(
  mapping: SiteMapping,
  settings: CapabilitySettings,
): CapabilityState[] {
  const available = availableRequirements(mapping);

  return CAPABILITY_LIST.map((capability) => {
    const supported = capability.requires.every((requirement) => available.has(requirement));
    return {
      id: capability.id,
      label: capability.label,
      description: capability.description,
      toolName: capability.id,
      enabled: supported && settings[capability.id] === true,
      supported,
      readOnly: capability.annotations.readOnlyHint === true,
    };
  });
}

export interface SetCapabilityResult {
  capabilities: CapabilityState[];
  /** True when the change was applied; false when the capability is unsupported. */
  applied: boolean;
  message?: string;
}

/**
 * Turns one capability on or off.
 *
 * A capability the scan found no data for cannot be turned on: registering a
 * tool that can only ever answer "not available" is worse for an agent than not
 * offering it.
 */
export async function setCapabilityEnabled(
  session: BuilderSession,
  siteId: string,
  capabilityId: CapabilityId,
  enabled: boolean,
): Promise<SetCapabilityResult> {
  const site = await requireOwnedSiteFor(session, siteId);
  const current = await loadCurrentSettings(site);

  if (!current) {
    throw new AppError("CONFLICT", "Scan your site before choosing what agents may do.");
  }

  const available = availableRequirements(current.mapping);
  const definition = CAPABILITY_CATALOGUE[capabilityId];
  const supported = definition.requires.every((requirement) => available.has(requirement));

  if (enabled && !supported) {
    return {
      capabilities: describeCapabilities(current.mapping, current.settings),
      applied: false,
      message: `Your site does not appear to have the information "${definition.label}" needs.`,
    };
  }

  const settings: CapabilitySettings = { ...current.settings, [capabilityId]: enabled };
  await persistDraft(site, current.mapping, settings);

  return {
    capabilities: describeCapabilities(current.mapping, settings),
    applied: true,
  };
}

/** Builds the exact payload the public endpoint serves. */
export function serializeRuntimeConfig(input: {
  publicId: string;
  origin: string;
  configVersion: number;
  mapping: SiteMapping;
  settings: CapabilitySettings;
  generatedAt: Date;
}): RuntimeConfig {
  // Built field by field on purpose. Spreading a database row here is exactly
  // how private data leaks into a public endpoint.
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    siteId: input.publicId,
    configVersion: input.configVersion,
    origin: input.origin,
    enabledCapabilities: enabledCapabilities(input.settings)
      .filter((capability) =>
        capability.requires.every((requirement) =>
          availableRequirements(input.mapping).has(requirement),
        ),
      )
      .map((capability) => capability.id),
    mapping: input.mapping,
    generatedAt: input.generatedAt.toISOString(),
  };
}

/** Writes a new immutable version without publishing it. */
async function persistDraft(
  site: Site,
  mapping: SiteMapping,
  settings: CapabilitySettings,
): Promise<ConfigVersion> {
  const latest = await prisma.configVersion.findFirst({
    where: { siteId: site.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  return prisma.configVersion.create({
    data: {
      siteId: site.id,
      version,
      runtimeConfig: asJson(
        serializeRuntimeConfig({
          publicId: site.publicId,
          origin: site.origin,
          configVersion: version,
          mapping,
          settings,
          generatedAt: new Date(),
        }),
      ),
    },
  });
}

export interface PublishResult {
  site: Site;
  configVersion: ConfigVersion;
  runtimeConfig: RuntimeConfig;
}

/**
 * Freezes the current settings into a version and makes it the published one.
 *
 * This is what the Generate Installation button — and the `generate_installation`
 * WebMCP tool — call.
 */
export async function publishConfiguration(
  session: BuilderSession,
  siteId: string,
): Promise<PublishResult> {
  const site = await requireOwnedSiteFor(session, siteId);
  const current = await loadCurrentSettings(site);

  if (!current) {
    throw new AppError(
      "CONFLICT",
      "Scan your site before generating an installation snippet.",
    );
  }

  const configVersion = await persistDraft(site, current.mapping, current.settings);

  const published = await prisma.site.update({
    where: { id: site.id },
    data: {
      publishedConfigVersionId: configVersion.id,
      status: "PUBLISHED",
    },
  });

  const stamped = await prisma.configVersion.update({
    where: { id: configVersion.id },
    data: { publishedAt: new Date() },
  });

  return {
    site: published,
    configVersion: stamped,
    runtimeConfig: stamped.runtimeConfig as unknown as RuntimeConfig,
  };
}

/**
 * The published configuration for a public site id, or null.
 *
 * The only path by which configuration reaches the public internet. Drafts are
 * unreachable from here by construction: it reads through
 * `Site.publishedConfigVersionId`, which only `publishConfiguration` sets.
 */
export async function getPublishedConfig(
  publicId: string,
): Promise<{ config: RuntimeConfig; origin: string; publishedAt: Date | null } | null> {
  const site = await prisma.site.findUnique({
    where: { publicId },
    select: {
      origin: true,
      publishedConfigVersion: {
        select: { runtimeConfig: true, publishedAt: true },
      },
    },
  });

  const version = site?.publishedConfigVersion;
  if (!site || !version) return null;

  // Publishing constructs this payload locally, but the route is a public
  // trust boundary and database JSON is still untrusted input when it is read
  // back. A malformed/manual row must fail closed rather than become a runtime
  // configuration or leak a shape we no longer intend to serve.
  const parsed = runtimeConfigSchema.safeParse(version.runtimeConfig);
  if (!parsed.success) return null;

  return {
    config: parsed.data,
    origin: site.origin,
    publishedAt: version.publishedAt,
  };
}
