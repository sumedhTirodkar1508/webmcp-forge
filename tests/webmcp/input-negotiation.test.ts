// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRegisteredTool } from "@/lib/webmcp/client";
import type { ModelContext, WebMcpRegisteredTool } from "@/lib/webmcp/types";

/**
 * Learning the browser's argument shape from the FIRST tool a user runs.
 *
 * Chrome's WebMCP preview rejects object arguments before dispatching, with
 * "Failed to parse input arguments". Negotiation used to be limited to
 * read-only tools and `prepare_contact_message`, so on a fresh context the
 * first `navigate_site` failed, the following `focus_project` failed, and the
 * mode was only discovered once something harmless happened to run.
 *
 * The failing attempt never dispatches, so retrying a repeatable tool costs
 * nothing. `send_contact_message` stays excluded regardless.
 */

const contextsUnderTest = new Set<object>();

afterEach(() => {
  contextsUnderTest.clear();
  vi.restoreAllMocks();
});

function tool(name: string, readOnlyHint: boolean): WebMcpRegisteredTool {
  return {
    name,
    description: `${name} tool`,
    window,
    origin: window.origin,
    annotations: { readOnlyHint },
  };
}

/**
 * A browser that accepts only pre-serialized arguments, rejecting objects
 * BEFORE the tool runs — so a rejected call executed nothing.
 */
function serializedOnlyBrowser(tools: WebMcpRegisteredTool[]) {
  const executions: Array<{ name: string; input: unknown }> = [];

  const executeTool = vi.fn(function (
    this: unknown,
    toolArg: WebMcpRegisteredTool,
    input: unknown,
  ) {
    if (typeof this !== "object" || this === null || !contextsUnderTest.has(this)) {
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': Illegal invocation",
      );
    }
    if (typeof input !== "string") {
      throw new Error("Failed to parse input arguments");
    }
    executions.push({ name: toolArg.name, input });
    return Promise.resolve(`ran:${toolArg.name}`);
  });

  const context = {
    registerTool: vi.fn(),
    getTools: vi.fn(async () => tools),
    executeTool,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ontoolchange: null,
  } as unknown as ModelContext;

  contextsUnderTest.add(context);
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(document, "modelContext", { value: context, configurable: true });

  return { context, executions, executeTool };
}

const ACTION_TOOLS = [
  tool("navigate_site", false),
  tool("focus_project", false),
  tool("prepare_contact_message", false),
  tool("send_contact_message", false),
  tool("get_skills", true),
];

describe("negotiating from an action tool on a fresh context", () => {
  it("1: navigate_site retries serialized, succeeds, and stores the mode", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    const result = await executeRegisteredTool("navigate_site", { destination: "Work" });

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    // Exactly one real dispatch: the object attempt never reached the tool.
    expect(executions).toEqual([
      { name: "navigate_site", input: '{"destination":"Work"}' },
    ]);
  });

  it("2: focus_project does the same as the very first tool", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    const result = await executeRegisteredTool("focus_project", { title: "Fieldnote" });

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    expect(executions).toEqual([
      { name: "focus_project", input: '{"title":"Fieldnote"}' },
    ]);
  });

  it("3: later tools use the stored mode with no extra attempt", async () => {
    const { context, executions } = serializedOnlyBrowser(ACTION_TOOLS);
    const spy = vi.spyOn(context, "executeTool");

    await executeRegisteredTool("navigate_site", { path: "/work" });
    const afterFirst = spy.mock.calls.length;

    await executeRegisteredTool("focus_project", { index: 0 });

    // One transport call, not a retry pair.
    expect(spy.mock.calls.length - afterFirst).toBe(1);
    expect(executions).toHaveLength(2);
  });
});

describe("what must NOT be retried", () => {
  it("4: a real handler failure is not retried for navigate_site", async () => {
    const tools = [tool("navigate_site", false)];
    const { context } = serializedOnlyBrowser(tools);

    let calls = 0;
    context.executeTool = vi.fn(function (this: unknown) {
      if (!contextsUnderTest.has(this as object)) throw new TypeError("Illegal invocation");
      calls += 1;
      // Dispatched and then failed — the tool really ran.
      throw new Error("the site's navigation handler exploded");
    }) as unknown as ModelContext["executeTool"];

    const result = await executeRegisteredTool("navigate_site", { path: "/work" });

    expect(result).toMatchObject({ ok: false, message: "the site's navigation handler exploded" });
    expect(calls).toBe(1);
  });

  it("4b: an Illegal invocation is never treated as a parse failure", async () => {
    const tools = [tool("focus_project", false)];
    const { context } = serializedOnlyBrowser(tools);

    let calls = 0;
    context.executeTool = vi.fn(() => {
      calls += 1;
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': Illegal invocation",
      );
    }) as unknown as ModelContext["executeTool"];

    const result = await executeRegisteredTool("focus_project", {});

    expect(result).toMatchObject({ ok: false });
    expect(calls).toBe(1);
  });

  it("5: send_contact_message never negotiates, on a fresh context", async () => {
    const { context, executions } = serializedOnlyBrowser(ACTION_TOOLS);
    const spy = vi.spyOn(context, "executeTool");

    const result = await executeRegisteredTool("send_contact_message", {
      confirmationId: "abc",
      confirmed: true,
    });

    // One attempt, honest failure, and nothing submitted.
    expect(result).toMatchObject({ ok: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(0);
  });

  it("5b: send_contact_message stays excluded even claiming to be read-only", async () => {
    // An annotation must not be able to unlock the retry for a submitting tool.
    const { context, executions } = serializedOnlyBrowser([
      tool("send_contact_message", true),
    ]);
    const spy = vi.spyOn(context, "executeTool");

    await executeRegisteredTool("send_contact_message", { confirmed: true });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(0);
  });

  it("5c: once the mode is known, send_contact_message dispatches exactly once", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    // A repeatable tool teaches the context first.
    await executeRegisteredTool("get_skills", {});
    await executeRegisteredTool("send_contact_message", {
      confirmationId: "abc",
      confirmed: true,
    });

    expect(executions.filter((e) => e.name === "send_contact_message")).toHaveLength(1);
  });
});

describe("existing behaviour preserved", () => {
  it("6: read-only tools still negotiate", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    const result = await executeRegisteredTool("get_skills", {});

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    expect(executions).toEqual([{ name: "get_skills", input: "{}" }]);
  });

  it("7: prepare_contact_message still negotiates", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    const result = await executeRegisteredTool("prepare_contact_message", {
      message: "Hello from WebMCP Forge.",
    });

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    expect(executions).toHaveLength(1);
  });

  it("8: an object-mode browser executes once and never retries", async () => {
    const executions: string[] = [];
    const context = {
      registerTool: vi.fn(),
      getTools: vi.fn(async () => ACTION_TOOLS),
      executeTool: vi.fn(function (this: unknown, t: WebMcpRegisteredTool, input: unknown) {
        if (!contextsUnderTest.has(this as object)) throw new TypeError("Illegal invocation");
        // A standards browser accepts the object form.
        expect(typeof input).toBe("object");
        executions.push(t.name);
        return Promise.resolve(`ran:${t.name}`);
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      ontoolchange: null,
    } as unknown as ModelContext;

    contextsUnderTest.add(context);
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(document, "modelContext", { value: context, configurable: true });

    const result = await executeRegisteredTool("navigate_site", { path: "/work" });

    expect(result).toMatchObject({ ok: true, inputMode: "object" });
    expect(executions).toEqual(["navigate_site"]);
  });

  it("9: no tool runs twice once a dispatch has happened", async () => {
    const { executions } = serializedOnlyBrowser(ACTION_TOOLS);

    for (const name of ["navigate_site", "focus_project", "get_skills", "prepare_contact_message"]) {
      await executeRegisteredTool(name, {});
    }

    // Each requested tool dispatched exactly once across the whole sequence.
    for (const name of ["navigate_site", "focus_project", "get_skills", "prepare_contact_message"]) {
      expect(executions.filter((e) => e.name === name), name).toHaveLength(1);
    }
  });
});
