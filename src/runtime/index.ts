import type { RuntimeConfig } from "@/lib/runtime-config";
import { RUNTIME_VERSION } from "@/lib/runtime-version";
import {
  checkWebMcpAvailability,
  registerTools,
  executeRegisteredTool,
  listRegisteredTools,
} from "@/lib/webmcp/client";
import { parseRuntimeConfig } from "@/runtime/config-guard";
import {
  buildTools,
  capabilityIsSatisfied,
  collectLiveCounts,
  type ToolContext,
} from "@/runtime/tools";

/**
 * WebMCP Forge browser runtime.
 *
 * This is the entire installed footprint on a portfolio: one `<script defer>`
 * tag. It is framework-free plain browser JavaScript — no React, no bundled UI,
 * nothing injected into the page's markup.
 *
 * What it does, in order:
 *   1. finds its own <script> element to learn the site id and the Forge origin
 *   2. fetches that site's published configuration, once
 *   3. registers the enabled generic WebMCP tools against `document.modelContext`
 *   4. re-registers on navigation, so route-scoped tools follow the user
 *   5. answers a one-time verification challenge, if asked
 *
 * What it never does: call Gemini, send the portfolio's content back to Forge
 * during ordinary tool use, or modify the host page beyond a temporary
 * highlight outline during `focus_project`.
 */

const GLOBAL_KEY = "__webmcpForge";
const VERIFY_PARAM = "__wmf_verify";

interface RuntimeState {
  version: string;
  siteId: string | null;
  configVersion: number | null;
  status: "loading" | "ready" | "error" | "idle";
  error?: string;
  webmcp: ReturnType<typeof checkWebMcpAvailability>;
  registeredTools: string[];
  failedTools: Array<{ name: string; message: string }>;
}

declare global {
  interface Window {
    [GLOBAL_KEY]?: ForgeRuntimeApi;
  }
}

interface ForgeRuntimeApi {
  version: string;
  getState: () => RuntimeState;
  getLiveCounts: () => Record<string, number>;
  /**
   * Invokes a tool through the browser's real WebMCP machinery
   * (`document.modelContext.executeTool`). Returns null when this browser has
   * no `executeTool`, so a caller can say so rather than silently substituting
   * a direct handler call and calling it the same thing.
   */
  invokeViaWebMcp: (
    name: string,
    input?: Record<string, unknown>,
  ) => Promise<{ ok: true; result: string } | { ok: false; message: string } | null>;
  /**
   * Calls the underlying handler directly, bypassing WebMCP. A diagnostic aid
   * only — this is NOT agent-mediated invocation and must never be presented
   * as one.
   */
  invokeHandlerDirectly: (
    name: string,
    input?: Record<string, unknown>,
  ) => Promise<unknown>;
}

function findOwnScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement && current.dataset.wmfSite) return current;
  // `defer` scripts have a null `document.currentScript` by the time they run,
  // so fall back to locating the tag by its marker attribute.
  return document.querySelector<HTMLScriptElement>("script[data-wmf-site]");
}

function log(message: string, detail?: unknown): void {
  // Namespaced and quiet: this runs on somebody else's site.
  if (detail === undefined) console.warn(`[webmcp-forge] ${message}`);
  else console.warn(`[webmcp-forge] ${message}`, detail);
}

async function fetchConfig(
  forgeOrigin: string,
  siteId: string,
): Promise<RuntimeConfig | null> {
  const endpoint = `${forgeOrigin}/api/public/sites/${encodeURIComponent(siteId)}/config`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      credentials: "omit",
      mode: "cors",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      log(`configuration unavailable (status ${response.status})`);
      return null;
    }
    return parseRuntimeConfig(await response.json());
  } catch {
    log("could not reach WebMCP Forge to load configuration");
    return null;
  }
}

function start(): void {
  if (window[GLOBAL_KEY]) return; // already installed

  const script = findOwnScript();
  const siteId = script?.dataset.wmfSite ?? null;

  const state: RuntimeState = {
    version: RUNTIME_VERSION,
    siteId,
    configVersion: null,
    status: "loading",
    webmcp: checkWebMcpAvailability(),
    registeredTools: [],
    failedTools: [],
  };

  let config: RuntimeConfig | null = null;
  let context: ToolContext | null = null;
  let dispose: (() => void) | null = null;
  let registrationGeneration = 0;

  const api: ForgeRuntimeApi = {
    version: RUNTIME_VERSION,
    getState: () => ({ ...state }),
    getLiveCounts: () => (context ? collectLiveCounts(context) : {}),
    invokeViaWebMcp: (name, input) => executeRegisteredTool(name, input ?? {}),
    invokeHandlerDirectly: async (name, input) => {
      if (!context) return null;
      const tool = buildTools(context).find((candidate) => candidate.name === name);
      if (!tool) return null;
      const controller = new AbortController();
      return tool.execute(input ?? {}, { signal: controller.signal });
    },
  };
  window[GLOBAL_KEY] = api;

  if (!script || !siteId) {
    state.status = "error";
    state.error = "missing data-wmf-site attribute";
    log("the script tag is missing its data-wmf-site attribute");
    return;
  }

  let forgeOrigin: string;
  try {
    forgeOrigin = new URL(script.src, window.location.href).origin;
  } catch {
    state.status = "error";
    state.error = "could not determine the Forge origin";
    return;
  }

  const currentUrl = () => window.location.href;

  /** (Re)registers tools for the current route. */
  const syncTools = async () => {
    if (!config || !context) return;
    const generation = ++registrationGeneration;
    dispose?.();
    dispose = null;

    const tools = buildTools(context);
    const result = await registerTools(tools);
    // A route change can arrive while a previous registration is still in
    // flight. Its controller no longer owns the active tool set, so abort it
    // rather than retaining stale registrations or overwriting the new
    // disposer when it eventually resolves.
    if (generation !== registrationGeneration) {
      result.dispose();
      return;
    }
    dispose = result.dispose;
    state.registeredTools = result.registered;
    state.failedTools = result.failed;
  };

  void (async () => {
    config = await fetchConfig(forgeOrigin, siteId);

    if (!config) {
      state.status = "error";
      state.error = "no published configuration";
      return;
    }

    if (config.siteId !== siteId) {
      state.status = "error";
      state.error = "configuration is for a different site";
      log("configuration site id does not match the script tag");
      return;
    }

    // A snippet copied onto a different domain must not silently appear to
    // work: its mappings and verification were built for one origin only.
    if (config.origin !== window.location.origin) {
      state.status = "error";
      state.error = "configuration was published for a different origin";
      log(
        `this configuration was published for ${config.origin}, but the page is on ${window.location.origin}`,
      );
      return;
    }

    state.configVersion = config.configVersion;
    context = { config, doc: document, currentUrl };

    if (state.webmcp.available) {
      await syncTools();
      state.status = "ready";
    } else {
      // Everything else still works — verification, diagnostics — so this is a
      // degraded state, not a failure.
      state.status = "idle";
    }

    watchNavigation(() => {
      if (state.webmcp.available) void syncTools();
    });

    await maybeVerify(forgeOrigin, config, context, state);
  })();
}

/**
 * Notices client-side route changes without destabilising the host page.
 *
 * `pushState`/`replaceState` are wrapped rather than polled, and the originals
 * are always called — a site's own router must keep working exactly as before.
 */
function watchNavigation(onChange: () => void): void {
  let lastPath = window.location.pathname;

  const notify = () => {
    if (window.location.pathname === lastPath) return;
    lastPath = window.location.pathname;
    onChange();
  };

  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);

  const history = window.history;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function patched(
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      const result = original.apply(this, args);
      // Defer so the site's own router settles before we re-read the DOM.
      window.setTimeout(notify, 0);
      return result;
    };
  }
}

/**
 * Answers an installation-verification challenge, when one is present in the URL.
 *
 * The raw challenge arrives as a query parameter, is POSTed once to Forge, and
 * is then stripped from the visible URL so it cannot be shared, bookmarked or
 * leaked through a Referer header. Only counts and health flags are reported —
 * never the portfolio's content.
 */
async function maybeVerify(
  forgeOrigin: string,
  config: RuntimeConfig,
  context: ToolContext,
  state: RuntimeState,
): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const challenge = params.get(VERIFY_PARAM);
  if (!challenge) return;

  // Strip first: even if the report fails, the secret should not linger.
  try {
    params.delete(VERIFY_PARAM);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  } catch {
    // A page that forbids history manipulation still gets to verify.
  }

  const registered = await listRegisteredTools();

  const payload = {
    siteId: config.siteId,
    challenge,
    runtimeVersion: RUNTIME_VERSION,
    configVersion: config.configVersion,
    path: window.location.pathname,
    webmcpAvailable: state.webmcp.available,
    webmcpReason: state.webmcp.reason ?? null,
    toolsRegistered: state.registeredTools.length,
    toolNames: state.registeredTools,
    toolsVisibleToBrowser: registered.map((tool) => tool.name),
    toolRegistrationFailures: state.failedTools,
    liveCounts: collectLiveCounts(context),
    mappingHealth: Object.fromEntries(
      config.enabledCapabilities.map((id) => [
        id,
        capabilityIsSatisfied(id, config.mapping),
      ]),
    ),
  };

  try {
    await fetch(`${forgeOrigin}/api/public/verify`, {
      method: "POST",
      credentials: "omit",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    log("could not report verification results back to WebMCP Forge");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
