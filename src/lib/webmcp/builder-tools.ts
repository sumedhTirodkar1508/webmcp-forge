import {
  CAPABILITY_IDS,
  isCapabilityId,
  type CapabilityId,
} from "@/lib/capabilities/catalogue";
import type { BuilderState } from "@/lib/services/types";
import { textResult, errorResult } from "@/lib/webmcp/client";
import type { WebMcpTool } from "@/lib/webmcp/types";

/**
 * WebMCP Forge's own builder tools — "use WebMCP to build WebMCP".
 *
 * These are registered by the builder page against the real
 * `document.modelContext`, so a WebMCP-capable agent can drive the product the
 * same way a person does: set a URL, scan, review, toggle a capability,
 * generate the installation.
 *
 * The important architectural rule is that these are a thin shell. Every tool
 * calls the same `BuilderActions` the on-screen buttons call, which call the
 * same HTTP endpoints, which call the same services. There is no parallel
 * implementation for agents, so the UI cannot drift out of step with what an
 * agent just did — the visible state updates because it is the same state.
 */

/** The operations the builder exposes, implemented once and shared. */
/**
 * The operations the builder exposes, implemented once and shared.
 *
 * Every site-scoped action takes an optional explicit `siteId`. A caller that
 * has just changed the target passes the id it was handed rather than relying
 * on React state having propagated — chaining `setTargetUrl` into `scan` is
 * exactly where an implicit read of "the current site" silently scanned the
 * site the user had navigated away from.
 */
export interface BuilderActions {
  getState: () => BuilderState;
  setTargetUrl: (url: string) => Promise<BuilderState>;
  scan: (siteId?: string) => Promise<BuilderState>;
  setCapabilityEnabled: (
    id: CapabilityId,
    enabled: boolean,
    siteId?: string,
  ) => Promise<{ state: BuilderState; applied: boolean; message?: string }>;
  generateInstallation: (siteId?: string) => Promise<BuilderState>;
  startVerification: (siteId?: string) => Promise<{ verifyUrl: string }>;
  /** Reloads the server-authoritative builder state after an out-of-band event
   * such as the portfolio runtime's verification callback. */
  refreshState: (siteId?: string) => Promise<BuilderState>;
}

const NO_SITE = "No site is loaded yet. Call set_target_url with a portfolio address first.";

/** Trims the state down to something an agent can read without drowning. */
function summarise(state: BuilderState) {
  return {
    targetUrl: state.targetUrl,
    title: state.title,
    status: state.status,
    platform: state.discovery?.platform ?? null,
    pagesScanned: state.discovery?.pagesScanned ?? 0,
    found: state.discovery?.found ?? {},
    missing: state.discovery?.missing ?? [],
    warnings: state.discovery?.warnings ?? [],
    clientRendered: state.discovery?.lowInformation ?? false,
    installed: Boolean(state.installation),
  };
}

function describeState(state: BuilderState): string {
  if (!state.siteId) return NO_SITE;
  const lines = [`Site: ${state.targetUrl}`, `Status: ${state.status}`];
  if (state.discovery) {
    lines.push(`Platform: ${state.discovery.platform}`);
    lines.push(`Pages scanned: ${state.discovery.pagesScanned}`);
    const found = Object.entries(state.discovery.found)
      .map(([key, value]) => `${value} ${key.toLowerCase()}`)
      .join(", ");
    if (found) lines.push(`Found: ${found}`);
    if (state.discovery.missing.length) {
      lines.push(`Not found: ${state.discovery.missing.join(", ")}`);
    }
  }
  return lines.join("\n");
}

function asString(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Builds the eight builder tools.
 *
 * Handlers are async and read `actions.getState()` fresh on each call rather
 * than closing over a snapshot, so a tool invoked after a UI change sees the
 * current state.
 */
export function buildBuilderTools(actions: BuilderActions): WebMcpTool[] {
  const readOnly = { readOnlyHint: true, untrustedContentHint: true };
  const mutating = { readOnlyHint: false, untrustedContentHint: true };

  return [
    {
      name: "set_target_url",
      title: "Set the portfolio address",
      description:
        "Sets the portfolio website WebMCP Forge should work on. Accepts a full URL. This changes the builder's state and the visible form.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The portfolio's address, e.g. https://example.com",
            maxLength: 2000,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      annotations: mutating,
      execute: async (input) => {
        const url = asString(input, "url", 2000);
        if (!url) return errorResult("Provide the portfolio's address as `url`.");
        try {
          const state = await actions.setTargetUrl(url);
          return textResult(`Target set to ${state.targetUrl}.`, summarise(state));
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : "Could not set that address.");
        }
      },
    },

    {
      name: "scan_site",
      title: "Scan the portfolio",
      description:
        "Crawls the target portfolio, extracts its structure, and interprets it. Takes several seconds. Must be called after set_target_url.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: mutating,
      execute: async () => {
        // Read the site once and pass it explicitly, for the same reason the
        // target form does: an agent may call scan_site immediately after
        // set_target_url, and "whatever site is current" must not be resolved
        // a second time in between.
        const siteId = actions.getState().siteId;
        if (!siteId) return errorResult(NO_SITE);
        try {
          const state = await actions.scan(siteId);
          return textResult(describeState(state), summarise(state));
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : "The scan failed.");
        }
      },
    },

    {
      name: "get_scan_summary",
      title: "Read the scan results",
      description:
        "Returns what the most recent scan discovered: platform, pages, the content sections found and any warnings.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: async () => {
        const state = actions.getState();
        if (!state.siteId) return errorResult(NO_SITE);
        if (!state.discovery) {
          return textResult("This site has not been scanned yet.", { scanned: false });
        }
        return textResult(describeState(state), summarise(state));
      },
    },

    {
      name: "get_capabilities",
      title: "List what agents may do",
      description:
        "Lists every capability, whether it is currently enabled, and whether the scan found the information it needs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: async () => {
        const state = actions.getState();
        if (!state.siteId) return errorResult(NO_SITE);
        if (state.capabilities.length === 0) {
          return textResult("Scan the site first to see what agents could do.", {
            capabilities: [],
          });
        }
        const text = state.capabilities
          .map(
            (capability) =>
              `${capability.enabled ? "on " : "off"} ${capability.toolName} — ${capability.label}${
                capability.supported ? "" : " (not available on this site)"
              }`,
          )
          .join("\n");
        return textResult(text, { capabilities: state.capabilities });
      },
    },

    {
      name: "set_capability_enabled",
      title: "Turn a capability on or off",
      description: `Enables or disables one capability. Valid ids: ${CAPABILITY_IDS.join(", ")}. The matching toggle in the builder updates immediately.`,
      inputSchema: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            description: "The capability id, e.g. get_contact_info",
            maxLength: 40,
          },
          enabled: { type: "boolean", description: "true to enable, false to disable" },
        },
        required: ["capability", "enabled"],
        additionalProperties: false,
      },
      annotations: mutating,
      execute: async (input) => {
        const state = actions.getState();
        if (!state.siteId) return errorResult(NO_SITE);

        const id = asString(input, "capability", 40);
        if (!id || !isCapabilityId(id)) {
          return errorResult(`Unknown capability. Valid ids: ${CAPABILITY_IDS.join(", ")}.`);
        }
        if (typeof input.enabled !== "boolean") {
          return errorResult("Provide `enabled` as true or false.");
        }

        try {
          const result = await actions.setCapabilityEnabled(id, input.enabled);
          if (!result.applied) {
            return textResult(result.message ?? "That capability is not available on this site.", {
              applied: false,
              capabilities: result.state.capabilities,
            });
          }
          return textResult(`${id} is now ${input.enabled ? "enabled" : "disabled"}.`, {
            applied: true,
            capabilities: result.state.capabilities,
          });
        } catch (error) {
          return errorResult(
            error instanceof Error ? error.message : "Could not change that setting.",
          );
        }
      },
    },

    {
      name: "generate_installation",
      title: "Generate the installation snippet",
      description:
        "Publishes the current capability settings and produces the one-line script tag to install on the portfolio.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: mutating,
      execute: async () => {
        if (!actions.getState().siteId) return errorResult(NO_SITE);
        try {
          const state = await actions.generateInstallation();
          if (!state.installation) {
            return errorResult("The installation snippet could not be generated.");
          }
          return textResult(
            `Installation ready. Add this to the portfolio:\n\n${state.installation.scriptTag}`,
            {
              scriptTag: state.installation.scriptTag,
              siteId: state.installation.publicId,
              generatedVersion: state.installation.latestGeneratedVersion,
              installedVersion: state.installation.installedVersion,
              enabledCapabilities: state.capabilities
                .filter((capability) => capability.enabled)
                .map((capability) => capability.toolName),
            },
          );
        } catch (error) {
          return errorResult(
            error instanceof Error ? error.message : "Could not generate the installation.",
          );
        }
      },
    },

    {
      name: "get_installation_instructions",
      title: "Read the installation steps",
      description:
        "Returns the installation snippet and the step-by-step instructions for the detected website platform.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: async () => {
        const state = actions.getState();
        if (!state.installation) {
          return textResult(
            "No installation has been generated yet. Call generate_installation first.",
            { ready: false },
          );
        }
        return textResult(
          `Platform: ${state.installation.platform}\n\n${state.installation.scriptTag}`,
          {
            ready: true,
            platform: state.installation.platform,
            scriptTag: state.installation.scriptTag,
            runtimeUrl: state.installation.runtimeUrl,
          },
        );
      },
    },

    {
      name: "get_verification_status",
      title: "Read the installation check",
      description:
        "Returns the result of the most recent installation check, including which diagnostics passed and any content changes detected since the previous check.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: readOnly,
      execute: async () => {
        let state = actions.getState();
        if (!state.siteId) return errorResult(NO_SITE);

        // Verification is reported by a different origin in a different tab.
        // Refresh through the same state endpoint the UI uses so this tool
        // never reports a stale in-memory snapshot as the latest status.
        try {
          state = await actions.refreshState();
        } catch (error) {
          return errorResult(
            error instanceof Error
              ? error.message
              : "Could not load the latest verification status.",
          );
        }
        if (!state.verification) {
          return textResult("This installation has not been checked yet.", { checked: false });
        }
        const text = state.verification.diagnostics
          .map((d) => `${d.status.toUpperCase().padEnd(5)} ${d.label}${d.detail ? ` — ${d.detail}` : ""}`)
          .join("\n");
        return textResult(text, state.verification);
      },
    },
  ];
}
