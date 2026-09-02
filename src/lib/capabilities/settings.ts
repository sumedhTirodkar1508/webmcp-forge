import { z } from "zod";

import {
  CAPABILITY_IDS,
  CAPABILITY_LIST,
  type CapabilityDefinition,
  type CapabilityId,
  type DataRequirement,
} from "@/lib/capabilities/catalogue";

/**
 * Validation and normalisation for stored capability settings.
 *
 * Kept apart from the catalogue itself so the catalogue stays import-free and
 * cheap to bundle into the installed browser runtime. Only server code and the
 * builder UI need Zod.
 */

/** Persisted enabled/disabled state for the capability catalogue. */
export const capabilitySettingsSchema = z.partialRecord(z.enum(CAPABILITY_IDS), z.boolean());

export type CapabilitySettings = Partial<Record<CapabilityId, boolean>>;

/**
 * Recommends defaults given which data categories the scan actually found.
 * A capability whose `requires` are not all satisfied is recommended off.
 */
export function recommendSettings(available: ReadonlySet<DataRequirement>): CapabilitySettings {
  const settings: CapabilitySettings = {};

  for (const capability of CAPABILITY_LIST) {
    const requirementsMet = capability.requires.every((requirement) => available.has(requirement));
    settings[capability.id] = capability.defaultEnabled && requirementsMet;
  }

  return settings;
}

/** Coerces an arbitrary untrusted value into a boolean. */
function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
    if (normalized === "true" || normalized === "1") {
      return true;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return Boolean(value);
}

/**
 * Normalises untrusted stored/incoming settings: drops unknown keys, coerces
 * values to boolean, and fills any gaps with `recommendSettings`.
 */
export function normalizeSettings(
  raw: unknown,
  available: ReadonlySet<DataRequirement>,
): CapabilitySettings {
  const settings: CapabilitySettings = { ...recommendSettings(available) };

  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const id of CAPABILITY_IDS) {
      if (Object.prototype.hasOwnProperty.call(record, id)) {
        settings[id] = coerceBoolean(record[id]);
      }
    }
  }

  return settings;
}

/** Returns the enabled capabilities from `settings`, sorted by `order`. */
export function enabledCapabilities(settings: CapabilitySettings): CapabilityDefinition[] {
  return CAPABILITY_LIST.filter((capability) => settings[capability.id] === true);
}
