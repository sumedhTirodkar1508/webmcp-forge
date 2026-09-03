import { describe, expect, it } from "vitest";

import {
  buildVerificationDiagnostics,
  type VerificationReport,
} from "@/lib/services/verification-service";

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    siteId: "wmf_test_site",
    challenge: "not-a-real-token",
    runtimeVersion: "1.0.0",
    configVersion: 1,
    // The version the snippet pinned.
    pinnedVersion: 1,
    path: "/",
    webmcpAvailable: true,
    webmcpReason: null,
    toolsRegistered: 2,
    toolNames: ["get_skills", "get_profile"],
    toolsVisibleToBrowser: ["list_projects", "get_skills", "get_profile"],
    toolRegistrationFailures: [],
    existingTools: ["list_projects"],
    conflictingTools: [],
    liveCounts: { skills: 4 },
    mappingHealth: { get_skills: true },
    ...overrides,
  };
}

describe("verification diagnostics", () => {
  it("reports generated tool collisions as a warning without treating native tools as a failure", () => {
    const diagnostics = buildVerificationDiagnostics(report({ conflictingTools: ["list_projects", "get_profile"] }));

    expect(diagnostics).toContainEqual({
      id: "tool_collisions",
      label: "2 generated tool names conflict with tools already provided by this site",
      status: "warn",
      detail: "left untouched: list_projects, get_profile",
    });
    expect(diagnostics.find((item) => item.id === "tools")?.status).toBe("pass");
  });

  it("separates existing, conflicting, Forge-added, and total browser tools", () => {
    const diagnostics = buildVerificationDiagnostics(
      report({
        existingTools: Array.from({ length: 11 }, (_, index) => `native_${index}`),
        conflictingTools: Array.from({ length: 7 }, (_, index) => `native_${index}`),
        toolsRegistered: 3,
        toolNames: ["search_projects", "get_skills", "navigate_site"],
        toolsVisibleToBrowser: Array.from({ length: 14 }, (_, index) => `tool_${index}`),
      }),
    );

    expect(diagnostics).toContainEqual(expect.objectContaining({
      id: "existing_tools",
      label: "Your portfolio already exposes 11 WebMCP tools",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      id: "tool_collisions",
      label: "7 generated tool names conflict with tools already provided by this site",
      status: "warn",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      id: "tools",
      label: "Forge added 3 WebMCP tools",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      id: "browser_tools",
      label: "14 total WebMCP tools visible to the browser",
    }));
  });

  it("describes individual skills and their groups without calling groups skills", () => {
    const diagnostics = buildVerificationDiagnostics(report({ liveCounts: { skills: 43, skillGroups: 6 } }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      id: "count_skills",
      label: "43 skills across 6 groups found on the page",
    }));
    expect(diagnostics.some((item) => item.id === "count_skillGroups")).toBe(false);
  });
});
