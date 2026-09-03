// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRegisteredTool, registerTools } from "@/lib/webmcp/client";
import type { ModelContext, WebMcpRegisteredTool, WebMcpTool } from "@/lib/webmcp/types";

function tool(name: string): WebMcpTool {
  return {
    name,
    description: `${name} test tool`,
    execute: async () => ({ content: [] }),
  };
}

/**
 * The set of ModelContext objects the current test installed.
 *
 * `receiverSensitive` checks membership rather than identity against a single
 * variable so a mock can be defined before the context object it belongs to
 * exists.
 */
const contextsUnderTest = new Set<object>();

/**
 * Wraps a mock `executeTool` so that it behaves like the real WebIDL method.
 *
 * `document.modelContext.executeTool` is a native method bound to its
 * ModelContext receiver: calling it as a bare function throws
 * `TypeError: Illegal invocation`. A plain `vi.fn()` does not care about
 * `this`, which is exactly why an unbound call once shipped and passed the
 * suite. This fixture reproduces the browser's requirement, so any
 * implementation that drops the receiver fails here instead of in production.
 */
function receiverSensitive<T>(
  implementation: (
    tool: WebMcpRegisteredTool,
    input: unknown,
    options: { signal?: AbortSignal },
  ) => Promise<T>,
) {
  return vi.fn(function (
    this: unknown,
    toolArg: WebMcpRegisteredTool,
    inputArg: unknown,
    optionsArg: { signal?: AbortSignal },
  ): Promise<T> {
    if (typeof this !== "object" || this === null || !contextsUnderTest.has(this)) {
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': Illegal invocation",
      );
    }
    return implementation(toolArg, inputArg, optionsArg);
  });
}

afterEach(() => {
  contextsUnderTest.clear();
});

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
    executeTool: receiverSensitive(async () => ""),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ontoolchange: null,
  } as unknown as ModelContext;
  contextsUnderTest.add(context);

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

describe("executeRegisteredTool", () => {
  function installedTool(readOnlyHint = true): WebMcpRegisteredTool {
    return {
      name: "get_profile",
      description: "Read the profile.",
      window,
      origin: window.origin,
      annotations: { readOnlyHint },
    };
  }

  it("uses the standards object input form first", async () => {
    const { context } = installContext([]);
    const registered = installedTool();
    context.getTools = vi.fn(async () => [registered]);
    context.executeTool = receiverSensitive(async () => "ok");

    await expect(executeRegisteredTool("get_profile", { detail: "full" })).resolves.toMatchObject({
      ok: true,
      result: "ok",
      inputMode: "object",
    });
    expect(context.executeTool).toHaveBeenCalledWith(registered, { detail: "full" }, {});
  });

  it("falls back to serialized input only for the legacy parse incompatibility", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool()]);
    let call = 0;
    context.executeTool = receiverSensitive(async () => {
      call += 1;
      if (call === 1) throw new Error("Failed to parse input arguments");
      return "legacy ok";
    });

    await expect(executeRegisteredTool("get_profile", { detail: "full" })).resolves.toMatchObject({
      ok: true,
      result: "legacy ok",
      inputMode: "serialized",
    });
    expect(context.executeTool).toHaveBeenNthCalledWith(1, expect.anything(), { detail: "full" }, {});
    expect(context.executeTool).toHaveBeenNthCalledWith(2, expect.anything(), '{"detail":"full"}', {});
  });

  it("does not retry a normal handler failure", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool()]);
    context.executeTool = receiverSensitive(async () => {
      throw new Error("portfolio handler rejected the request");
    });

    await expect(executeRegisteredTool("get_profile")).resolves.toEqual({
      ok: false,
      message: "portfolio handler rejected the request",
    });
    expect(context.executeTool).toHaveBeenCalledTimes(1);
  });

  it("never retries a side-effecting tool", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool(false)]);
    context.executeTool = receiverSensitive(async () => {
      throw new Error("Failed to parse input arguments");
    });

    await executeRegisteredTool("get_profile", { message: "hello" });
    expect(context.executeTool).toHaveBeenCalledTimes(1);
  });

  it("forwards an abort signal to both compatible call forms", async () => {
    const { context } = installContext([]);
    const controller = new AbortController();
    context.getTools = vi.fn(async () => [installedTool()]);
    context.executeTool = receiverSensitive(async () => "ok");

    await executeRegisteredTool("get_profile", {}, controller.signal);
    expect(context.executeTool).toHaveBeenCalledWith(expect.anything(), {}, { signal: controller.signal });
  });

  it("returns null when executeTool is unsupported", async () => {
    const { context } = installContext([]);
    context.executeTool = undefined as unknown as ModelContext["executeTool"];
    await expect(executeRegisteredTool("get_profile")).resolves.toBeNull();
  });

  it("rejects malformed browser results", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool()]);
    context.executeTool = receiverSensitive(async () => ({ unexpected: true })) as unknown as ModelContext["executeTool"];
    await expect(executeRegisteredTool("get_profile")).resolves.toEqual({
      ok: false,
      message: "The browser returned an invalid tool result.",
    });
  });
  // --- receiver binding -------------------------------------------------
  //
  // Regression for a real browser failure: the legacy compatibility path
  // extracted `context.executeTool` into a local and called it unbound, so
  // Chrome threw "Illegal invocation" the moment that path was taken.

  it("preserves the ModelContext receiver on the standards call", async () => {
    const { context } = installContext([]);
    const registered = installedTool();
    context.getTools = vi.fn(async () => [registered]);

    const receivers: unknown[] = [];
    context.executeTool = receiverSensitive(async function (this: unknown) {
      return "ok";
    }) as unknown as ModelContext["executeTool"];
    const spy = vi.spyOn(context, "executeTool");

    await executeRegisteredTool("get_profile", { detail: "full" });

    // `vi.spyOn` records the `this` each call was made with.
    for (const call of spy.mock.contexts ?? []) receivers.push(call);
    expect(receivers.every((receiver) => receiver === context)).toBe(true);
  });

  it("preserves the receiver on the legacy serialized retry", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool()]);

    // The receiver-sensitive mock throws "Illegal invocation" if `this` is
    // lost, so an unbound legacy call surfaces here as a failure rather than
    // as a passing test.
    let call = 0;
    context.executeTool = receiverSensitive(async (_tool, input) => {
      call += 1;
      if (call === 1) throw new Error("Failed to parse input arguments");
      return `legacy:${String(input)}`;
    });

    await expect(executeRegisteredTool("get_profile", { detail: "full" })).resolves.toMatchObject({
      ok: true,
      result: 'legacy:{"detail":"full"}',
      inputMode: "serialized",
    });
    expect(call).toBe(2);
  });

  it("surfaces an Illegal invocation instead of retrying it as a parse failure", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool()]);

    let calls = 0;
    context.executeTool = receiverSensitive(async () => {
      calls += 1;
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': Illegal invocation",
      );
    });

    const result = await executeRegisteredTool("get_profile", { detail: "full" });
    expect(result).toEqual({
      ok: false,
      message: "Failed to execute 'executeTool' on 'ModelContext': Illegal invocation",
    });
    // An illegal invocation is a binding bug, not an argument-shape problem,
    // so it must never trigger the compatibility retry.
    expect(calls).toBe(1);
  });

  it("runs a side-effecting tool exactly once even on a parse failure", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool(false)]);

    let executions = 0;
    context.executeTool = receiverSensitive(async () => {
      executions += 1;
      throw new Error("Failed to parse input arguments");
    });

    // `installedTool(false)` is the fixture's tool with readOnlyHint: false —
    // i.e. a consequential action such as submitting a contact form.
    await executeRegisteredTool("get_profile", { message: "hello" });
    expect(executions).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("input mode negotiation", () => {
  function installedTool(name: string, readOnlyHint: boolean): WebMcpRegisteredTool {
    return {
      name,
      description: `${name} tool`,
      window,
      origin: window.origin,
      annotations: { readOnlyHint },
    };
  }

  /**
   * A browser that only accepts pre-serialized arguments, like Chrome's early
   * WebMCP preview. It rejects an object BEFORE dispatching to the tool, which
   * is what makes learning the mode safe.
   */
  function serializedOnlyContext(tools: WebMcpRegisteredTool[]) {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => tools);

    const executions: Array<{ name: string; input: unknown }> = [];
    context.executeTool = receiverSensitive(async (tool, input) => {
      if (typeof input !== "string") {
        // Rejected before execution — the handler never runs.
        throw new Error("Failed to parse input arguments");
      }
      executions.push({ name: tool.name, input });
      return `ran:${tool.name}`;
    });

    return { context, executions };
  }

  it("learns the serialized mode from a read-only tool", async () => {
    const { executions } = serializedOnlyContext([installedTool("get_skills", true)]);

    const result = await executeRegisteredTool("get_skills", {});
    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    expect(executions).toHaveLength(1);
  });

  it("reuses the learned mode without retrying on later calls", async () => {
    const tools = [installedTool("get_skills", true), installedTool("send_contact_message", false)];
    const { context, executions } = serializedOnlyContext(tools);
    const spy = vi.spyOn(context, "executeTool");

    await executeRegisteredTool("get_skills", {});
    const callsAfterProbe = spy.mock.calls.length;

    // The consequential tool now goes straight to the known shape.
    const result = await executeRegisteredTool("send_contact_message", {
      confirmationId: "abc",
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    // Exactly one additional transport call: no trial-and-error.
    expect(spy.mock.calls.length - callsAfterProbe).toBe(1);
    expect(executions.filter((e) => e.name === "send_contact_message")).toHaveLength(1);
  });

  it("lets prepare_contact_message establish the mode, because it submits nothing", async () => {
    const { executions } = serializedOnlyContext([
      installedTool("prepare_contact_message", false),
    ]);

    const result = await executeRegisteredTool("prepare_contact_message", { message: "hi" });

    expect(result).toMatchObject({ ok: true, inputMode: "serialized" });
    expect(executions).toHaveLength(1);
  });

  it("NEVER probes with send_contact_message", async () => {
    const { context, executions } = serializedOnlyContext([
      installedTool("send_contact_message", false),
    ]);
    const spy = vi.spyOn(context, "executeTool");

    const result = await executeRegisteredTool("send_contact_message", {
      confirmationId: "abc",
      confirmed: true,
    });

    // With the mode unknown, a submitting tool gets ONE standards attempt and
    // an honest failure — never a second attempt in a different shape, which
    // could submit the form twice.
    expect(result).toMatchObject({ ok: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(executions).toHaveLength(0);
  });

  it("runs a consequential tool exactly once once the mode is known", async () => {
    const tools = [installedTool("get_skills", true), installedTool("send_contact_message", false)];
    const { executions } = serializedOnlyContext(tools);

    await executeRegisteredTool("get_skills", {});
    await executeRegisteredTool("send_contact_message", { confirmationId: "a", confirmed: true });
    await executeRegisteredTool("send_contact_message", { confirmationId: "b", confirmed: true });

    // Two distinct sends, two executions. Never a duplicate for one call.
    expect(executions.filter((e) => e.name === "send_contact_message")).toHaveLength(2);
  });

  it("does not renegotiate after a genuine handler failure", async () => {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [installedTool("get_skills", true)]);

    let calls = 0;
    context.executeTool = receiverSensitive(async () => {
      calls += 1;
      throw new Error("the site's handler exploded");
    });

    const result = await executeRegisteredTool("get_skills", {});
    expect(result).toMatchObject({ ok: false, message: "the site's handler exploded" });
    // A handler error is not an argument-shape problem.
    expect(calls).toBe(1);
  });
});

describe("result normalization", () => {
  function jsonContext(payload: string) {
    const { context } = installContext([]);
    context.getTools = vi.fn(async () => [
      {
        name: "get_skills",
        description: "skills",
        window,
        origin: window.origin,
        annotations: { readOnlyHint: true },
      } as WebMcpRegisteredTool,
    ]);
    context.executeTool = receiverSensitive(async () => payload);
    return context;
  }

  it("parses a JSON envelope so callers do not each re-parse it", async () => {
    jsonContext(
      JSON.stringify({
        content: [{ type: "text", text: "Cloud & DevOps: Kubernetes" }],
        structuredContent: { totalSkills: 43, totalGroups: 6 },
      }),
    );

    const outcome = await executeRegisteredTool("get_skills", {});
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome || !outcome.ok) throw new Error("expected success");

    expect(typeof outcome.result).toBe("object");
    expect(outcome.result).toMatchObject({
      structuredContent: { totalSkills: 43, totalGroups: 6 },
    });
    // The untouched payload stays available for the relay and diagnostics.
    expect(typeof outcome.rawResult).toBe("string");
    expect(outcome.rawResult).toContain("totalSkills");
  });

  it("preserves plain text rather than failing on it", async () => {
    jsonContext("just a sentence");

    const outcome = await executeRegisteredTool("get_skills", {});
    expect(outcome).toMatchObject({ ok: true, result: "just a sentence" });
  });

  it("keeps malformed JSON as text instead of throwing", async () => {
    jsonContext('{"content": [oops');

    const outcome = await executeRegisteredTool("get_skills", {});
    expect(outcome).toMatchObject({ ok: true, result: '{"content": [oops' });
  });
});
