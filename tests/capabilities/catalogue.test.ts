import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_IDS,
  CAPABILITY_LIST,
  type CapabilityId,
  type DataRequirement,
  getCapability,
  isCapabilityId,
} from "@/lib/capabilities/catalogue";
import {
  enabledCapabilities,
  normalizeSettings,
  recommendSettings,
} from "@/lib/capabilities/settings";

const ALL_DATA: ReadonlySet<DataRequirement> = new Set<DataRequirement>([
  "profile",
  "projects",
  "skills",
  "experience",
  "education",
  "contact",
  "navigation",
]);

describe("CAPABILITY_CATALOGUE", () => {
  it("has exactly 10 entries with the expected ids", () => {
    const expectedIds: CapabilityId[] = [
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
    ];

    expect(CAPABILITY_IDS.length).toBe(10);
    expect(Object.keys(CAPABILITY_CATALOGUE).length).toBe(10);
    expect([...CAPABILITY_IDS].sort()).toEqual([...expectedIds].sort());
    expect(CAPABILITY_LIST.length).toBe(10);
  });

  it("marks navigate_site and focus_project as not read-only, and everything else read-only", () => {
    for (const capability of CAPABILITY_LIST) {
      if (capability.id === "navigate_site" || capability.id === "focus_project") {
        expect(capability.annotations.readOnlyHint).toBe(false);
      } else {
        expect(capability.annotations.readOnlyHint).toBe(true);
      }
    }
  });

  it("sets untrustedContentHint true on every entry", () => {
    for (const capability of CAPABILITY_LIST) {
      expect(capability.annotations.untrustedContentHint).toBe(true);
    }
  });

  it("sets additionalProperties: false on every inputSchema", () => {
    for (const capability of CAPABILITY_LIST) {
      expect(capability.inputSchema.type).toBe("object");
      expect(capability.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("uses only generic, non-site-specific tool names", () => {
    const pattern = /^[a-z][a-z0-9_]*$/;
    for (const id of CAPABILITY_IDS) {
      expect(id).toMatch(pattern);
    }
  });

  it("gives every capability a label, description and agentDescription", () => {
    for (const capability of CAPABILITY_LIST) {
      expect(capability.label.length).toBeGreaterThan(0);
      expect(capability.description.length).toBeGreaterThan(0);
      expect(capability.agentDescription.length).toBeGreaterThan(0);
    }
  });

  it("bounds list_projects limit/offset and gives get_project/search_projects/focus_project/navigate_site the documented shape", () => {
    const listProjects = CAPABILITY_CATALOGUE.list_projects;
    expect(listProjects.inputSchema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 20,
    });
    expect(listProjects.inputSchema.properties.offset).toMatchObject({
      type: "integer",
      minimum: 0,
      default: 0,
    });

    const searchProjects = CAPABILITY_CATALOGUE.search_projects;
    expect(searchProjects.inputSchema.required).toEqual(["query"]);
    expect(searchProjects.inputSchema.properties.query).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 200,
    });

    for (const id of ["get_project", "focus_project"] as const) {
      const schema = CAPABILITY_CATALOGUE[id].inputSchema;
      expect(schema.properties.id).toMatchObject({ type: "string", maxLength: 200 });
      expect(schema.properties.title).toMatchObject({ type: "string", maxLength: 200 });
      expect(schema.properties.index).toMatchObject({ type: "integer", minimum: 0 });
      expect(schema.required).toBeUndefined();
    }

    const navigateSite = CAPABILITY_CATALOGUE.navigate_site;
    expect(navigateSite.inputSchema.properties.destination).toMatchObject({
      type: "string",
      maxLength: 200,
    });
    expect(navigateSite.inputSchema.properties.path).toMatchObject({
      type: "string",
      maxLength: 500,
    });
    expect(navigateSite.agentDescription).toMatch(/same-origin/i);
  });
});

describe("getCapability / isCapabilityId", () => {
  it("returns the matching definition for a known id", () => {
    expect(getCapability("get_profile")?.id).toBe("get_profile");
    expect(getCapability("focus_project")?.id).toBe("focus_project");
  });

  it("returns undefined for unknown ids", () => {
    expect(getCapability("delete_everything")).toBeUndefined();
    expect(getCapability("")).toBeUndefined();
  });

  it("narrows via isCapabilityId", () => {
    expect(isCapabilityId("get_skills")).toBe(true);
    expect(isCapabilityId("not_a_real_tool")).toBe(false);
    expect(isCapabilityId(42)).toBe(false);
    expect(isCapabilityId(null)).toBe(false);
  });
});

describe("recommendSettings", () => {
  it("turns off capabilities whose requirements are missing", () => {
    const settings = recommendSettings(new Set());
    for (const capability of CAPABILITY_LIST) {
      expect(settings[capability.id]).toBe(false);
    }
  });

  it("turns on capabilities whose requirements are satisfied", () => {
    const settings = recommendSettings(ALL_DATA);
    for (const capability of CAPABILITY_LIST) {
      expect(settings[capability.id]).toBe(true);
    }
  });

  it("only enables capabilities whose specific requirement is present", () => {
    const settings = recommendSettings(new Set<DataRequirement>(["projects"]));
    expect(settings.list_projects).toBe(true);
    expect(settings.get_project).toBe(true);
    expect(settings.search_projects).toBe(true);
    expect(settings.focus_project).toBe(true);
    expect(settings.get_profile).toBe(false);
    expect(settings.get_skills).toBe(false);
    expect(settings.navigate_site).toBe(false);
  });
});

describe("normalizeSettings", () => {
  it("drops unknown keys", () => {
    const result = normalizeSettings(
      { get_profile: true, some_unknown_tool: true, delete_everything: true },
      ALL_DATA,
    );
    expect(Object.keys(result).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect((result as Record<string, unknown>).some_unknown_tool).toBeUndefined();
  });

  it("coerces non-boolean values to booleans", () => {
    const result = normalizeSettings(
      {
        get_profile: "true",
        list_projects: "false",
        get_skills: 1,
        get_experience: 0,
        get_education: "yes please",
      },
      ALL_DATA,
    );
    expect(result.get_profile).toBe(true);
    expect(result.list_projects).toBe(false);
    expect(result.get_skills).toBe(true);
    expect(result.get_experience).toBe(false);
    expect(result.get_education).toBe(true);
  });

  it("keeps explicitly-set known keys rather than silently discarding them", () => {
    // navigate_site has no satisfied requirement here, so the recommended
    // default is false, but an explicit `true` from the caller must survive.
    const result = normalizeSettings({ navigate_site: true }, new Set());
    expect(result.navigate_site).toBe(true);
  });

  it("fills gaps from recommendSettings when raw is missing, null, or not an object", () => {
    const expected = recommendSettings(ALL_DATA);

    expect(normalizeSettings(undefined, ALL_DATA)).toEqual(expected);
    expect(normalizeSettings(null, ALL_DATA)).toEqual(expected);
    expect(normalizeSettings("not an object", ALL_DATA)).toEqual(expected);
    expect(normalizeSettings(42, ALL_DATA)).toEqual(expected);
    expect(normalizeSettings([true, false], ALL_DATA)).toEqual(expected);
  });
});

describe("enabledCapabilities", () => {
  it("returns only enabled capabilities, sorted by order", () => {
    const result = enabledCapabilities({
      get_contact_info: true,
      get_profile: true,
      focus_project: false,
      list_projects: false,
    });

    expect(result.map((capability) => capability.id)).toEqual(["get_profile", "get_contact_info"]);
  });

  it("returns an empty list when nothing is enabled", () => {
    expect(enabledCapabilities({})).toEqual([]);
  });

  it("respects the catalogue's declared order for a full enabled set", () => {
    const settings = recommendSettings(ALL_DATA);
    const result = enabledCapabilities(settings);
    const orders = result.map((capability) => capability.order);
    const sortedDescending = [...orders].sort((a, b) => b - a);
    expect(orders).toEqual(sortedDescending);
    expect(result.length).toBe(10);
  });
});
