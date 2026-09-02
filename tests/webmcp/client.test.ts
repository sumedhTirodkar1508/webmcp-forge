// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerTools } from "@/lib/webmcp/client";
import type { ModelContext, WebMcpTool } from "@/lib/webmcp/types";

function tool(name: string): WebMcpTool {
  return {
    name,
    description: `${name} test tool`,
    execute: async () => ({ content: [] }),
  };
}

function installContext(nativeNames: string[]) {
  const names = new Set(nativeNames);
  const registerTool = vi.fn(async (candidate: WebMcpTool, options?: { signal?: AbortSignal }) => {
    if (names.has(candidate.name)) throw new Error("A tool with that name already exists.");
    names.add(candidate.name);
    options?.signal?.addEventListener("abort", () => names.delete(candidate.name), { once: true });
  });
  const context = {
    registerTool,
    getTools: vi.fn(async () => [...names].map((name) => ({ name, window, origin: window.origin }))),
    executeTool: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ontoolchange: null,
  } as unknown as ModelContext;

  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(document, "modelContext", { value: context, configurable: true });
  return { context, names, registerTool };
}

afterEach(() => {
  Object.defineProperty(document, "modelContext", { value: undefined, configurable: true });
});

describe("registerTools", () => {
  it("detects native-name collisions and leaves those tools untouched", async () => {
    const { names, registerTool } = installContext(["list_projects", "site_native_tool"]);

    const result = await registerTools([tool("list_projects"), tool("get_skills")]);

    expect(result.existingTools).toEqual(["list_projects", "site_native_tool"]);
    expect(result.conflictingTools).toEqual(["list_projects"]);
    expect(result.registered).toEqual(["get_skills"]);
    expect(result.failed).toEqual([]);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(names).toEqual(new Set(["list_projects", "site_native_tool", "get_skills"]));

    result.dispose();
    expect(names).toEqual(new Set(["list_projects", "site_native_tool"]));
  });

  it("reports a browser registration failure without stopping unrelated tools", async () => {
    const { context } = installContext([]);
    context.registerTool = vi.fn(async (candidate) => {
      if (candidate.name === "bad") throw new Error("schema rejected");
    });

    const result = await registerTools([tool("bad"), tool("good")]);

    expect(result.conflictingTools).toEqual([]);
    expect(result.registered).toEqual(["good"]);
    expect(result.failed).toEqual([{ name: "bad", message: "schema rejected" }]);
  });
});
