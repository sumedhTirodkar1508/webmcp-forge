/**
 * Typings for the WebMCP browser API.
 *
 * WebMCP is a W3C Web Machine Learning Community Group draft and is not in
 * TypeScript's DOM lib, so the shapes below are transcribed from the
 * specification's WebIDL rather than guessed:
 *
 *   partial interface Document {
 *     [SecureContext, SameObject] readonly attribute ModelContext modelContext;
 *   };
 *
 *   [Exposed=Window, SecureContext]
 *   interface ModelContext : EventTarget {
 *     Promise<undefined> registerTool(ModelContextTool tool,
 *                                     optional ModelContextRegisterToolOptions options = {});
 *     Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
 *     Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject = {},
 *                                    optional ModelContextExecuteToolOptions options = {});
 *     attribute EventHandler ontoolchange;
 *   };
 *
 * This module is the single place the experimental surface is described. Nothing
 * else in the codebase may reach for `document.modelContext` directly or cast
 * around the type system to talk to it — everything goes through
 * `src/lib/webmcp/client.ts`. When the spec moves, this file moves with it and
 * the rest of the application does not.
 *
 * Types only: safe to import from server code, browser code and tests alike.
 */

/** JSON Schema describing a tool's input. Kept loose — the spec says `object`. */
export type ToolInputSchema = Record<string, unknown>;

export interface WebMcpToolAnnotations {
  /** The tool neither changes state nor changes what the user is looking at. */
  readOnlyHint?: boolean;
  /** Results originate from content the page does not control. Always true for
   *  us: everything we return was read out of a third-party portfolio's DOM. */
  untrustedContentHint?: boolean;
}

export interface WebMcpToolExecuteOptions {
  signal: AbortSignal;
}

export type WebMcpToolExecute = (
  input: Record<string, unknown>,
  options: WebMcpToolExecuteOptions,
) => Promise<unknown>;

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: ToolInputSchema;
  execute: WebMcpToolExecute;
  annotations?: WebMcpToolAnnotations;
}

export interface WebMcpRegisterToolOptions {
  /** Origins allowed to see this tool. Omitted means the default policy. */
  exposedTo?: string[];
  /** Aborting this signal unregisters the tool. */
  signal?: AbortSignal;
}

export interface WebMcpRegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: ToolInputSchema;
  window: Window;
  origin: string;
  annotations?: WebMcpToolAnnotations;
}

export interface WebMcpGetToolsOptions {
  fromOrigins?: string[];
}

export interface WebMcpExecuteToolOptions {
  signal?: AbortSignal;
}

export interface ModelContext extends EventTarget {
  registerTool(tool: WebMcpTool, options?: WebMcpRegisterToolOptions): Promise<void>;
  getTools(options?: WebMcpGetToolsOptions): Promise<WebMcpRegisteredTool[]>;
  executeTool(
    tool: WebMcpRegisteredTool,
    input?: Record<string, unknown>,
    options?: WebMcpExecuteToolOptions,
  ): Promise<string>;
  ontoolchange: ((this: ModelContext, event: Event) => unknown) | null;
}

/**
 * The conventional result envelope. The spec's `execute` returns `Promise<any>`;
 * MCP's own content-block convention is what agents expect to receive, so that
 * is what we emit.
 */
export interface WebMcpTextResult {
  content: Array<{ type: "text"; text: string }>;
  /** Machine-readable payload alongside the human-readable text. */
  structuredContent?: unknown;
  isError?: boolean;
}
