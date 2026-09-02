import type { RuntimeConfig } from "@/lib/runtime-config";
import { CAPABILITY_IDS } from "@/lib/capabilities/catalogue";

/**
 * A hand-rolled structural check for the configuration payload.
 *
 * The server validates with Zod before publishing, but the runtime revalidates
 * anyway — the response could come from a stale cache or a misconfigured proxy,
 * and a half-formed mapping should degrade to "no tools" rather than to a page
 * full of exceptions on somebody else's website.
 *
 * Deliberately hand-written rather than importing Zod: this file is bundled
 * into a script that loads on every visitor's page view, and a validation
 * library would multiply its size for no benefit at this scale.
 */

const CAPABILITY_SET = new Set<string>(CAPABILITY_IDS);
const SELECTOR_ALLOWED = /^[A-Za-z0-9\s\-_.#[\]="':>+~^$*|(),/@]+$/;
const SELECTOR_FORBIDDEN = /(javascript:|<|;|\\|\{|\}|expression\(|url\()/i;
const ROUTE_PATTERN = /^(\*|\/[A-Za-z0-9\-._~/*]*)$/;
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9\-_:]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeSelector(value: unknown, allowEmpty = false): value is string {
  if (allowEmpty && value === "") return true;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    !SELECTOR_FORBIDDEN.test(value) &&
    SELECTOR_ALLOWED.test(value)
  );
}

function isRoutePattern(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && ROUTE_PATTERN.test(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isFieldMapping(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isSafeSelector(value.selector, true)) return false;
  const source = value.source;
  if (source !== "text" && source !== "href" && source !== "src" && source !== "attr") {
    return false;
  }
  if (source === "attr" && (typeof value.attribute !== "string" || !ATTRIBUTE_NAME.test(value.attribute))) {
    return false;
  }
  return true;
}

function isListMapping(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isRoutePattern(value.route) || !isSafeSelector(value.itemSelector)) return false;
  if (value.containerSelector !== undefined && !isSafeSelector(value.containerSelector)) return false;
  if (!isObject(value.fields)) return false;
  return Object.values(value.fields).every(isFieldMapping);
}

function isSingleMapping(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isRoutePattern(value.route)) return false;
  if (!isObject(value.fields)) return false;
  return Object.values(value.fields).every(isFieldMapping);
}

/** Returns the config when it is structurally sound, or null. */
export function parseRuntimeConfig(value: unknown): RuntimeConfig | null {
  if (!isObject(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.siteId !== "string" || !value.siteId) return null;
  if (
    typeof value.configVersion !== "number" ||
    !Number.isInteger(value.configVersion) ||
    value.configVersion < 1
  ) {
    return null;
  }
  if (!isHttpUrl(value.origin)) return null;
  if (typeof value.generatedAt !== "string") return null;

  if (!Array.isArray(value.enabledCapabilities)) return null;
  if (!value.enabledCapabilities.every((id) => typeof id === "string" && CAPABILITY_SET.has(id))) {
    return null;
  }

  const mapping = value.mapping;
  if (!isObject(mapping) || mapping.version !== 1) return null;

  for (const key of ["projects", "skills", "experience", "education"] as const) {
    if (mapping[key] !== undefined && !isListMapping(mapping[key])) return null;
  }
  for (const key of ["profile", "projectDetail"] as const) {
    if (mapping[key] !== undefined && !isSingleMapping(mapping[key])) return null;
  }
  if (mapping.projectDetailRoute !== undefined && !isRoutePattern(mapping.projectDetailRoute)) {
    return null;
  }
  if (mapping.navigation !== undefined) {
    const nav = mapping.navigation;
    if (!isObject(nav) || !Array.isArray(nav.items)) return null;
    const itemsOk = nav.items.every(
      (item) =>
        isObject(item) &&
        typeof item.label === "string" &&
        typeof item.path === "string" &&
        /^\/(?!\/)/.test(item.path),
    );
    if (!itemsOk) return null;
  }
  if (mapping.contact !== undefined) {
    const contact = mapping.contact;
    if (!isObject(contact)) return null;
    if (!isRoutePattern(contact.route) || !Array.isArray(contact.emails) || !Array.isArray(contact.socials)) {
      return null;
    }
    if (contact.list !== undefined && !isListMapping(contact.list)) return null;
  }

  return value as unknown as RuntimeConfig;
}
