import { describe, expect, it, vi } from "vitest";

import { buildBuilderTools, type BuilderActions } from "@/lib/webmcp/builder-tools";
import type { BuilderState } from "@/lib/services/types";
import type { WebMcpTextResult, WebMcpTool } from "@/lib/webmcp/types";

const EMPTY_STATE: BuilderState = {
  siteId: null,
  publicId: null,
  targetUrl: null,
  origin: null,
  title: null,
  status: "DRAFT",
  discovery: null,
  capabilities: [],
  installation: null,
  verification: null,
  demoQuestionsRemaining: 0,
};

const READY_STATE: BuilderState = {
  ...EMPTY_STATE,
  siteId: "00000000-0000-4000-8000-000000000001",
  publicId: "wmf_0123456789ABCDEFGHJKMNPQ",
  targetUrl: "https://portfolio.example/",
  origin: "https://portfolio.example",
  status: "PUBLISHED",
  discovery: {
    platform: "CUSTOM",
    platformConfidence: 0.5,
    pagesScanned: 2,
    routePatterns: ["/", "/work/*"],
    found: { Projects: 2 },
    missing: [],
    warnings: [],
    lowInformation: false,
    usedAi: false,
    aiModel: null,
    aiFellBack: false,
    scannedAt: "2026-09-02T00:00:00.000Z",
  },
  capabilities: [
    {
      id: "list_projects",
      label: "Browse my projects",
      description: "",
      toolName: "list_projects",
      enabled: true,
      supported: true,
      readOnly: true,
    },
  ],
  installation: {
    publicId: "wmf_0123456789ABCDEFGHJKMNPQ",
    scriptTag:
      '<script data-wmf-site="wmf_0123456789ABCDEFGHJKMNPQ" data-wmf-config="1"></script>',
    runtimeUrl: "https://forge.example/runtime/v1.js",
    platform: "CUSTOM",
    latestGeneratedVersion: 1,
    generatedAt: "2026-09-02T00:00:00.000Z",
    installedVersion: null,
  },
};

function resultText(result: unknown): string {
  return (result as WebMcpTextResult).content[0]?.text ?? "";
}

function tool(tools: WebMcpTool[], name: string): WebMcpTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

function actions(state: BuilderState): BuilderActions {
  return {
    getState: vi.fn(() => state),
    setTargetUrl: vi.fn(async () => READY_STATE),
    scan: vi.fn(async () => READY_STATE),
    setCapabilityEnabled: vi.fn(async () => ({ state: READY_STATE, applied: true })),
    generateInstallation: vi.fn(async () => READY_STATE),
    startVerification: vi.fn(async () => ({ verifyUrl: "https://portfolio.example/?__wmf_verify=x" })),
    refreshState: vi.fn(async () => READY_STATE),
  };
}

const options = { signal: new AbortController().signal };

describe("WebMCP builder tools", () => {
  it("exposes the required fixed tool surface with truthful annotations", () => {
    const tools = buildBuilderTools(actions(EMPTY_STATE));
    expect(tools.map((item) => item.name)).toEqual([
      "set_target_url",
      "scan_site",
      "get_scan_summary",
      "get_capabilities",
      "set_capability_enabled",
      "generate_installation",
      "get_installation_instructions",
      "get_verification_status",
    ]);
    expect(tool(tools, "get_capabilities").annotations?.readOnlyHint).toBe(true);
    expect(tool(tools, "set_target_url").annotations?.readOnlyHint).toBe(false);
  });

  it("uses shared actions for a target and capability mutation", async () => {
    const shared = actions(READY_STATE);
    const tools = buildBuilderTools(shared);

    const targetResult = await tool(tools, "set_target_url").execute(
      { url: "https://portfolio.example" },
      options,
    );
    expect(shared.setTargetUrl).toHaveBeenCalledWith("https://portfolio.example");
    expect(resultText(targetResult)).toContain("Target set to");

    const capabilityResult = await tool(tools, "set_capability_enabled").execute(
      { capability: "list_projects", enabled: false },
      options,
    );
    expect(shared.setCapabilityEnabled).toHaveBeenCalledWith("list_projects", false);
    expect(resultText(capabilityResult)).toContain("disabled");
  });

  it("refreshes server state before reporting an out-of-band verification callback", async () => {
    const verified: BuilderState = {
      ...READY_STATE,
      verification: {
        status: "success",
        checkedAt: "2026-09-02T01:00:00.000Z",
        runtimeVersion: "1.0.0",
        configVersion: 1,
        webmcpAvailable: true,
        toolsRegistered: 2,
        diagnostics: [{ id: "runtime", label: "Agent runtime installed", status: "pass" }],
        liveCounts: { projects: 2 },
        changes: [],
      },
    };
    const shared = actions(READY_STATE);
    shared.refreshState = vi.fn(async () => verified);

    const result = await tool(buildBuilderTools(shared), "get_verification_status").execute({}, options);
    expect(shared.refreshState).toHaveBeenCalledOnce();
    expect(resultText(result)).toContain("Agent runtime installed");
  });
});
