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
    const diagnostics = buildVerificationDiagnostics(
      report({ conflictingTools: ["list_projects", "get_profile"] }),
      1,
    );

    expect(diagnostics).toContainEqual({
      id: "tool_collisions",
      label: "2 generated tool names conflict with tools already provided by this site",
      status: "warn",
      detail: "left untouched: list_projects, get_profile",
    });
    expect(diagnostics.find((item) => item.id === "tools")?.status).toBe("pass");
  });
});
