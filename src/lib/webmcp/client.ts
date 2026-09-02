import type {
  ModelContext,
  WebMcpRegisteredTool,
  WebMcpRegisterToolOptions,
  WebMcpTextResult,
  WebMcpTool,
} from "@/lib/webmcp/types";

/**
 * The one adapter between WebMCP Forge and the experimental WebMCP browser API.
 *
 * Everything that could differ between browsers, or change as the draft moves,
 * is contained here: feature detection, the secure-context requirement, and the
 * single unavoidable cast from `Document` to the spec's partial interface.
 *
 * Nothing here polyfills or simulates WebMCP. If the browser does not implement
 * it, `getModelContext()` returns null and callers degrade honestly — the
 * builder shows an unavailable state rather than pretending.
 */

/** Why WebMCP is not usable right now, for display to a human. */
export type WebMcpUnavailableReason =
  | "not_a_browser"
  | "insecure_context"
  | "not_implemented";

export interface WebMcpAvailability {
  available: boolean;
  reason?: WebMcpUnavailableReason;
  /** Short, user-facing explanation. */
  message?: string;
}

interface DocumentWithModelContext extends Document {
  modelContext?: ModelContext;
}

/**
 * Returns the live `document.modelContext`, or null when this browser does not
 * expose it. Never throws.
 */
export function getModelContext(): ModelContext | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  // WebMCP is `[SecureContext]`. `isSecureContext` is true on https and on
  // http://localhost, which is why local development works.
  if (window.isSecureContext === false) return null;

  const candidate = (document as DocumentWithModelContext).modelContext;
  if (!candidate || typeof candidate.registerTool !== "function") return null;
  return candidate;
}

/** Feature detection with a reason, for the builder's status panel. */
export function checkWebMcpAvailability(): WebMcpAvailability {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return {
      available: false,
      reason: "not_a_browser",
      message: "No browser environment.",
    };
  }
  if (window.isSecureContext === false) {
    return {
      available: false,
      reason: "insecure_context",
      message:
        "WebMCP requires a secure context. Serve this page over HTTPS (localhost also counts).",
    };
  }
  if (!getModelContext()) {
    return {
      available: false,
      reason: "not_implemented",
      message:
        "This browser does not expose document.modelContext yet. Everything else still works; agent tools will appear once your browser supports WebMCP.",
    };
  }
  return { available: true };
}

/** True when `executeTool` — genuine agent-style invocation — is available. */
export function canExecuteTools(): boolean {
  const context = getModelContext();
  return Boolean(context && typeof context.executeTool === "function");
}

/**
 * Registers a set of tools and returns a disposer.
 *
 * Unregistration in the spec is by aborting the `signal` handed to
 * `registerTool`, so one controller governs the whole set. Registration is
 * best-effort per tool: one rejected tool (a duplicate name, an invalid schema)
 * must not take the rest down with it.
 */
export interface RegisterToolsResult {
  /** Tool names present before Forge attempted registration, when enumerable. */
  existingTools: string[];
  /** Forge names already owned by the host page and intentionally skipped. */
  conflictingTools: string[];
  registered: string[];
  failed: Array<{ name: string; message: string }>;
  /** Unregisters everything registered by this call. */
  dispose: () => void;
}

export async function registerTools(
  tools: WebMcpTool[],
  options: WebMcpRegisterToolOptions = {},
): Promise<RegisterToolsResult> {
  const context = getModelContext();
  if (!context) {
    return {
      existingTools: [],
      conflictingTools: [],
      registered: [],
      failed: [],
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const registered: string[] = [];
  const failed: Array<{ name: string; message: string }> = [];
  // getTools is optional in practice while the WebMCP draft evolves. When it
  // works, reserve native names before we call registerTool; when it does not,
  // registration remains best-effort and duplicate-name rejection is reported.
  const existingTools = await listRegisteredTools();
  const existingNames = new Set(existingTools.map((tool) => tool.name));
  const conflictingTools = tools
    .filter((tool) => existingNames.has(tool.name))
    .map((tool) => tool.name);

  for (const tool of tools) {
    if (existingNames.has(tool.name)) continue;
    try {
      await context.registerTool(tool, {
        ...(options.exposedTo ? { exposedTo: options.exposedTo } : {}),
        signal: controller.signal,
      });
      registered.push(tool.name);
    } catch (error) {
      failed.push({
        name: tool.name,
        message: error instanceof Error ? error.message : "registration failed",
      });
    }
  }

  return {
    existingTools: [...existingNames].slice(0, 50),
    conflictingTools: conflictingTools.slice(0, 50),
    registered,
    failed,
    dispose: () => controller.abort(),
  };
}

/** Tools this page has registered, as the browser sees them. */
export async function listRegisteredTools(): Promise<WebMcpRegisteredTool[]> {
  const context = getModelContext();
  if (!context) return [];
  try {
    return await context.getTools();
  } catch {
    return [];
  }
}

/**
 * Invokes a registered tool **through the browser's own WebMCP machinery**.
 *
 * This is genuine agent-path invocation, not a direct call to our handler: the
 * browser looks the tool up among what it has registered and drives it. That
 * distinction is the whole reason this function exists — see
 * `docs/` and the README on what does and does not count as a real WebMCP test.
 *
 * Returns null when the browser does not support `executeTool`, so callers can
 * say so plainly instead of substituting a direct call and calling it the same
 * thing.
 */
export async function executeRegisteredTool(
  name: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<{ ok: true; result: string } | { ok: false; message: string } | null> {
  const context = getModelContext();
  if (!context || typeof context.executeTool !== "function") return null;

  try {
    const tools = await context.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { ok: false, message: `No registered tool named ${name}.` };
    }
    const result = await context.executeTool(tool, input, signal ? { signal } : {});
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}

/** Builds the conventional MCP text+structured result envelope. */
export function textResult(text: string, structured?: unknown): WebMcpTextResult {
  return {
    content: [{ type: "text", text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

export function errorResult(text: string): WebMcpTextResult {
  return { content: [{ type: "text", text }], isError: true };
}
