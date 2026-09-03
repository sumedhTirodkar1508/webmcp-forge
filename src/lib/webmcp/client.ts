import type {
  ModelContext,
  WebMcpExecuteToolOptions,
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
/**
 * How this browser wants tool arguments passed.
 *
 * The current draft says `executeTool(tool, inputObject, options)`. Chrome's
 * early preview instead expected the arguments pre-serialized as a JSON
 * string, and rejects an object with "Failed to parse input arguments" before
 * it ever dispatches to the tool.
 */
export type WebMcpInputMode = "unknown" | "object" | "serialized";

/**
 * The negotiated mode, per ModelContext.
 *
 * Keyed on the context object itself rather than stored globally or persisted:
 * a full page load builds a new ModelContext and renegotiates, while SPA
 * navigation within the same document keeps what was already learned. Nothing
 * about a browser quirk belongs in the database.
 */
const inputModes = new WeakMap<ModelContext, Exclude<WebMcpInputMode, "unknown">>();

/**
 * Tools that may NEVER take part in mode negotiation.
 *
 * `send_contact_message` submits a real message through someone's form. Even
 * though the parse failure below is provably pre-dispatch, this list is an
 * absolute stop: nothing about a browser-compatibility workaround should be
 * able to reach a submitting tool twice. Checked before anything else, so an
 * annotation claiming otherwise cannot override it.
 */
const NEVER_NEGOTIATE = new Set(["send_contact_message", "submit_contact_message"]);

/**
 * Tools whose effects are safely repeatable, and may therefore be retried once
 * in the other argument shape.
 *
 * Read-only tools qualify by definition. The three named here qualify because
 * running them twice is indistinguishable from running them once:
 *
 *   `navigate_site`            asks the browser to go to a URL
 *   `focus_project`            scrolls an element into view
 *   `prepare_contact_message`  stages a draft in page memory, sends nothing
 *
 * These were previously excluded because they change the viewport, which meant
 * a fresh browser context could not learn its input mode from an action tool:
 * the first `navigate_site` failed, the next `focus_project` failed, and the
 * mode was only discovered once some harmless read tool happened to run. The
 * failing attempt never dispatched anything, so nothing was gained by that.
 */
const REPEATABLE_TOOLS = new Set([
  "navigate_site",
  "focus_project",
  "prepare_contact_message",
]);

/** Whether this tool may be retried in the other argument shape. */
function canNegotiateWith(tool: WebMcpRegisteredTool): boolean {
  if (NEVER_NEGOTIATE.has(tool.name)) return false;
  return tool.annotations?.readOnlyHint === true || REPEATABLE_TOOLS.has(tool.name);
}

/** The mode currently known for the live ModelContext. */
export function getInputMode(): WebMcpInputMode {
  const context = getModelContext();
  if (!context) return "unknown";
  return inputModes.get(context) ?? "unknown";
}

/** Test seam: forgets what was negotiated for the live ModelContext. */
export function resetInputMode(): void {
  const context = getModelContext();
  if (context) inputModes.delete(context);
}

/**
 * Calls `executeTool` with arguments in the given shape.
 *
 * `executeTool` is a WebIDL-backed native method bound to its ModelContext
 * receiver, so the serialized form — which needs a cast the published types
 * rightly disallow — must restore that receiver explicitly or the browser
 * throws `TypeError: Illegal invocation`.
 */
async function callExecuteTool(
  context: ModelContext,
  tool: WebMcpRegisteredTool,
  input: Record<string, unknown>,
  options: WebMcpExecuteToolOptions,
  mode: Exclude<WebMcpInputMode, "unknown">,
): Promise<unknown> {
  if (mode === "object") {
    return context.executeTool(tool, input, options);
  }

  const legacyExecute = context.executeTool as unknown as (
    this: ModelContext,
    registeredTool: WebMcpRegisteredTool,
    serializedInput: string,
    executeOptions: WebMcpExecuteToolOptions,
  ) => Promise<unknown>;

  return legacyExecute.call(context, tool, JSON.stringify(input), options);
}

/**
 * Matches ONLY the browser's pre-execution argument-parsing rejection.
 *
 * This is what makes negotiation safe: the error means the browser refused the
 * arguments before dispatching, so the tool provably did not run. Any other
 * failure — a handler error, an abort, or an `Illegal invocation` from a lost
 * receiver — is real and must propagate untouched.
 */
function isInputParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/illegal invocation/i.test(error.message)) return false;
  return /failed to parse input arguments/i.test(error.message);
}

/**
 * Executes a tool, negotiating the argument shape at most once per context.
 *
 * Once the mode is known every later call uses it directly, so a consequential
 * tool never performs trial-and-error. When the mode is still unknown and the
 * tool is not safe to probe, the standards form is attempted exactly once and
 * a parse failure is reported honestly rather than retried — an unexplained
 * second attempt at a submitting tool is worse than a clear error.
 */
async function executeWithNegotiation(
  context: ModelContext,
  tool: WebMcpRegisteredTool,
  input: Record<string, unknown>,
  options: WebMcpExecuteToolOptions,
): Promise<unknown> {
  const known = inputModes.get(context);
  if (known) return callExecuteTool(context, tool, input, options, known);

  try {
    const result = await callExecuteTool(context, tool, input, options, "object");
    inputModes.set(context, "object");
    return result;
  } catch (error) {
    if (!isInputParseFailure(error) || !canNegotiateWith(tool)) throw error;

    const result = await callExecuteTool(context, tool, input, options, "serialized");
    inputModes.set(context, "serialized");
    return result;
  }
}

/** A tool result, parsed when the browser handed back JSON text. */
export interface NormalizedToolResult {
  ok: true;
  /** Parsed envelope when the payload was JSON; the raw text otherwise. */
  result: WebMcpTextResult | string;
  /** Exactly what the browser returned, before parsing. */
  rawResult: string;
  /** Which argument shape this browser turned out to want. */
  inputMode: WebMcpInputMode;
}

export type ExecuteToolOutcome =
  | NormalizedToolResult
  | { ok: false; message: string }
  | null;

/**
 * Chrome returns the tool result as a JSON string. Parsing it here means every
 * caller — DevTools, the live relay, tests — sees one consistent shape instead
 * of each re-parsing. A tool that legitimately returns plain text is preserved
 * as text rather than treated as an error.
 */
function normalizeResult(raw: string, inputMode: WebMcpInputMode): NormalizedToolResult {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { ok: true, result: JSON.parse(trimmed) as WebMcpTextResult, rawResult: raw, inputMode };
    } catch {
      // Not valid JSON after all; fall through and keep it as text.
    }
  }
  return { ok: true, result: raw, rawResult: raw, inputMode };
}

/**
 * Invokes a registered tool **through the browser's own WebMCP machinery**.
 *
 * This is genuine agent-path invocation, not a direct call to our handler: the
 * browser looks the tool up among what it has registered and drives it.
 *
 * Returns null when the browser does not support `executeTool`, so callers can
 * say so plainly instead of substituting a direct call and calling it the same
 * thing.
 */
export async function executeRegisteredTool(
  name: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ExecuteToolOutcome> {
  const context = getModelContext();
  if (!context || typeof context.executeTool !== "function") return null;

  try {
    const tools = await context.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { ok: false, message: `No registered tool named ${name}.` };
    }

    const options = signal ? { signal } : {};
    const result = await executeWithNegotiation(context, tool, input, options);

    if (typeof result !== "string") {
      return { ok: false, message: "The browser returned an invalid tool result." };
    }
    return normalizeResult(result, inputModes.get(context) ?? "unknown");
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
