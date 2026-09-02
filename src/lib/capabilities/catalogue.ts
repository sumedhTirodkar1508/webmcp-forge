/**
 * The fixed, generic WebMCP capability catalogue for WebMCP Forge.
 *
 * This module is imported from BOTH server code (the site builder, API routes)
 * and the browser runtime script that calls
 * `document.modelContext.registerTool(...)`. It therefore has ZERO imports and
 * no Node- or DOM-specific APIs — the Zod-backed settings helpers live in
 * `./settings.ts` so that bundling the catalogue into the browser runtime does
 * not drag a validation library along with it.
 *
 * Tool names are always generic (never site-specific) so the same runtime
 * script works unmodified across every portfolio it is installed on.
 */

/** A minimal JSON Schema (draft-2020-12 style) object property. */
export interface JsonSchemaProperty {
  type: "string" | "integer" | "number" | "boolean";
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: string | number | boolean;
}

/**
 * A minimal JSON Schema (draft-2020-12 style) object schema, sufficient to
 * describe the `inputSchema` of a WebMCP tool descriptor without pulling in
 * a full JSON-Schema library.
 */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export const CAPABILITY_IDS = [
  "get_profile",
  "list_projects",
  "get_project",
  "search_projects",
  "get_skills",
  "get_experience",
  "get_education",
  "get_contact_info",
  "navigate_site",
  "focus_project",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * The category of extracted site data a capability depends on. The scanner
 * reports which of these it was able to find; a capability whose
 * requirements are not all satisfied should not be recommended.
 */
export type DataRequirement =
  | "profile"
  | "projects"
  | "skills"
  | "experience"
  | "education"
  | "contact"
  | "navigation";

export interface CapabilityDefinition {
  id: CapabilityId;
  /** Friendly, user-facing label (e.g. shown in the builder UI). */
  label: string;
  /** One plain-English sentence explaining this capability to a non-technical portfolio owner. */
  description: string;
  /** The `description` sent to agents in the WebMCP tool descriptor. */
  agentDescription: string;
  /** JSON Schema (draft-2020-12 style) describing the tool's input. */
  inputSchema: JsonSchemaObject;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  /** Which extracted data categories must exist for this capability to work. */
  requires: DataRequirement[];
  /** Recommended default when the scan found the required data. */
  defaultEnabled: boolean;
  /** Higher sorts first in the builder UI. */
  order: number;
}

/**
 * Input schema for the no-argument read-only lookups. A factory rather than a
 * shared constant so that six catalogue entries never alias one mutable object.
 */
function emptyObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

/** Shared input schema shape for tools that identify a project by one of id/title/index. */
function projectIdentifierSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The project's unique id, if known.",
        maxLength: 200,
      },
      title: {
        type: "string",
        description: "The project's title, if known.",
        maxLength: 200,
      },
      index: {
        type: "integer",
        description: "The project's zero-based position in the project list, if known.",
        minimum: 0,
      },
    },
    additionalProperties: false,
  };
}

export const CAPABILITY_CATALOGUE: Record<CapabilityId, CapabilityDefinition> = {
  get_profile: {
    id: "get_profile",
    label: "Learn about me",
    description:
      "Lets an agent read a short introduction about you — your name, headline and bio — the way a visitor would see it on your site.",
    agentDescription:
      "Returns the site owner's profile information (name, headline, bio) as extracted from the live page. Read-only.",
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["profile"],
    defaultEnabled: true,
    order: 100,
  },
  list_projects: {
    id: "list_projects",
    label: "Browse my projects",
    description:
      "Lets an agent list the projects shown on your site, with their titles, descriptions and links.",
    agentDescription:
      "Lists projects extracted from the live page, in the order they appear, including titles, short descriptions and links. Supports pagination via optional limit/offset. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of projects to return.",
          minimum: 1,
          maximum: 50,
          default: 20,
        },
        offset: {
          type: "integer",
          description: "Number of projects to skip before returning results.",
          minimum: 0,
          default: 0,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["projects"],
    defaultEnabled: true,
    order: 90,
  },
  get_project: {
    id: "get_project",
    label: "Inspect a project",
    description:
      "Lets an agent look up the full details of one specific project, such as its description, tools used and links.",
    agentDescription:
      "Returns full details for a single project extracted from the live page. Provide at least one of id, title or index to identify the project. Read-only.",
    inputSchema: projectIdentifierSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["projects"],
    defaultEnabled: true,
    order: 80,
  },
  search_projects: {
    id: "search_projects",
    label: "Search projects",
    description:
      "Lets an agent search your projects by keyword, so visitors can quickly find relevant work.",
    agentDescription:
      "Searches projects extracted from the live page for a text query against titles, descriptions and tags, returning the best matches. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text to match against project titles, descriptions and tags.",
          minLength: 1,
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: "Maximum number of matching projects to return.",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["projects"],
    defaultEnabled: true,
    order: 70,
  },
  get_skills: {
    id: "get_skills",
    label: "Show my skills",
    description: "Lets an agent list the skills and technologies shown on your site.",
    agentDescription:
      "Returns the list of skills and technologies extracted from the live page. Read-only.",
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["skills"],
    defaultEnabled: true,
    order: 60,
  },
  get_experience: {
    id: "get_experience",
    label: "Read my experience",
    description:
      "Lets an agent read your work experience — job titles, companies and dates — as shown on your site.",
    agentDescription:
      "Returns work experience entries (roles, organizations, dates, highlights) extracted from the live page. Read-only.",
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["experience"],
    defaultEnabled: true,
    order: 50,
  },
  get_education: {
    id: "get_education",
    label: "Read my education",
    description:
      "Lets an agent read your education history — schools, degrees and dates — as shown on your site.",
    agentDescription:
      "Returns education entries (institutions, degrees, dates) extracted from the live page. Read-only.",
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["education"],
    defaultEnabled: true,
    order: 40,
  },
  get_contact_info: {
    id: "get_contact_info",
    label: "Share contact information",
    description:
      "Lets an agent share the contact details you've published, such as your email or social links.",
    agentDescription:
      "Returns publicly published contact information (e.g. email, social links) extracted from the live page. Read-only.",
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    requires: ["contact"],
    defaultEnabled: true,
    order: 30,
  },
  navigate_site: {
    id: "navigate_site",
    label: "Navigate my portfolio",
    description:
      "Lets an agent move a visitor to a different section or page of your site, like jumping to your About or Work page.",
    agentDescription:
      "Navigates the current page to another section or same-origin path on this site, mimicking a visitor clicking a nav link. The `path`, if given, must be a same-origin path beginning with \"/\" — cross-origin destinations are not allowed. This changes what the browser is displaying, so it is not read-only.",
    inputSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: 'A navigation label to go to, e.g. "About" or "Work".',
          maxLength: 200,
        },
        path: {
          type: "string",
          description:
            'A same-origin path to navigate to, beginning with "/" (e.g. "/projects"). Must be same-origin.',
          maxLength: 500,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    requires: ["navigation"],
    defaultEnabled: true,
    order: 20,
  },
  focus_project: {
    id: "focus_project",
    label: "Focus a project",
    description:
      "Lets an agent scroll to and highlight one of your projects, drawing the visitor's attention to it.",
    agentDescription:
      "Scrolls the current page to bring a specific project into view and highlights it. Provide at least one of id, title or index to identify the project. This changes what the browser is displaying, so it is not read-only.",
    inputSchema: projectIdentifierSchema(),
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    requires: ["projects"],
    defaultEnabled: true,
    order: 10,
  },
};

export const CAPABILITY_LIST: readonly CapabilityDefinition[] = CAPABILITY_IDS.map(
  (id) => CAPABILITY_CATALOGUE[id],
).sort((a, b) => b.order - a.order);

export function getCapability(id: string): CapabilityDefinition | undefined {
  return isCapabilityId(id) ? CAPABILITY_CATALOGUE[id] : undefined;
}

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}
