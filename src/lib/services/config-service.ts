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

  // The working draft is what the builder is editing. Config versions are
  // immutable snapshots of past decisions and must not be read back as
  // "current" — doing so made the newest generated version look active.
  const available = availableRequirements(artifacts.mapping);
  const settings = site.draftSettings
    ? normalizeSettings(site.draftSettings, available)
    : artifacts.settings;

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

  // Editing a toggle is not a deployment decision. It updates the working
  // draft; only an explicit generate action appends an immutable version.
  //
  // The change is applied in the database as a merge of this ONE key, not by
  // writing back a whole settings object read a moment earlier. Two toggles
  // landing together — two tabs, or an agent and a person — would otherwise
  // each write their own snapshot and the second would silently undo the
  // first. When no draft exists yet, the current settings (the scan's
  // recommendation) become the starting point.
  const rows = await prisma.$queryRaw<Array<{ draft_settings: unknown }>>`
    UPDATE "sites"
    SET "draft_settings" =
          (CASE WHEN jsonb_typeof("draft_settings") = 'object'
                THEN "draft_settings"
                ELSE ${JSON.stringify(current.settings)}::jsonb
           END) || jsonb_build_object(${capabilityId}::text, ${enabled}::boolean),
        "updated_at" = now()
    WHERE "id" = ${site.id}::uuid
    RETURNING "draft_settings"`;

  // Describe what is actually stored now, including any change that landed
  // concurrently, rather than this request's own view of it.
  const settings = normalizeSettings(rows[0]?.draft_settings, available);

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
/**
 * Appends the next immutable configuration version.
 *
 * Two generations racing for the same site must receive two distinct versions
 * rather than colliding, so a unique-violation on `(siteId, version)` is
 * retried against a freshly read maximum. Existing rows are never updated —
 * a version is a permanent record of something a website may be pinned to.
 */
async function appendConfigVersion(
  site: Site,
  mapping: SiteMapping,
  settings: CapabilitySettings,
): Promise<ConfigVersion> {
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const latest = await prisma.configVersion.findFirst({
      where: { siteId: site.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    try {
      return await prisma.configVersion.create({
        data: {
          siteId: site.id,
          version,
          publishedAt: new Date(),
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
    } catch (error) {
      const raced =
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002";
      if (!raced || attempt === MAX_ATTEMPTS - 1) throw error;
      // Someone else took this number; read the new maximum and try again.
    }
  }

  throw new AppError("CONFLICT", "Could not allocate a configuration version.");
}

export interface GenerateResult {
  site: Site;
  configVersion: ConfigVersion;
  runtimeConfig: RuntimeConfig;
}

/**
 * Freezes the current draft into a new immutable configuration version.
 *
 * Deliberately does NOT mark anything active. Generating a configuration in
 * Forge must never change what a live website executes — the website pins the
 * version it runs in `data-wmf-config`, so a configuration only takes effect
 * once someone with deployment access to that website updates the snippet.
 *
 * That is what makes an ownership model unnecessary in this MVP: a stranger
 * can generate v3, but the site keeps running the v2 it pins.
 */
export async function generateConfiguration(
  session: BuilderSession,
  siteId: string,
): Promise<GenerateResult> {
  const site = await requireOwnedSiteFor(session, siteId);
  const current = await loadCurrentSettings(site);

  if (!current) {
    throw new AppError(
      "CONFLICT",
      "Scan your site before generating an installation snippet.",
    );
  }

  const configVersion = await appendConfigVersion(site, current.mapping, current.settings);

  const updated = await prisma.site.update({
    where: { id: site.id },
    data: { status: "PUBLISHED" },
  });

  return {
    site: updated,
    configVersion,
    runtimeConfig: configVersion.runtimeConfig as unknown as RuntimeConfig,
  };
}

/**
 * Returns one EXACT configuration version for a public site id.
 *
 * There is deliberately no "latest" fallback. A website pins the version it
 * runs, and silently serving a different one would mean a configuration nobody
 * deployed started executing on a live site. A missing version is an error the
 * runtime surfaces, not something to paper over.
 */
export async function getConfigVersion(
  publicId: string,
  version: number,
): Promise<{ config: RuntimeConfig; origin: string; publishedAt: Date | null } | null> {
  const site = await prisma.site.findUnique({
    where: { publicId },
    select: { id: true, origin: true },
  });
  if (!site) return null;

  const row = await prisma.configVersion.findUnique({
    where: { siteId_version: { siteId: site.id, version } },
    select: { runtimeConfig: true, publishedAt: true },
  });
  if (!row) return null;

  // The route is a public trust boundary and database JSON is untrusted input
  // when read back, so a malformed row fails closed rather than becoming a
  // runtime configuration.
  const parsed = runtimeConfigSchema.safeParse(row.runtimeConfig);
  if (!parsed.success) return null;

  return { config: parsed.data, origin: site.origin, publishedAt: row.publishedAt };
}

/** The highest version generated for a site, for display only. */
export async function getLatestGeneratedVersion(siteId: string): Promise<number | null> {
  const latest = await prisma.configVersion.findFirst({
    where: { siteId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return latest?.version ?? null;
}
