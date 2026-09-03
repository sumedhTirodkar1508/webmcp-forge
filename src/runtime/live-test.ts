import { executeRegisteredTool, listRegisteredTools } from "@/lib/webmcp/client";

/**
 * Live agent test mode.
 *
 * This is the only circumstance in which an installed portfolio talks to WebMCP
 * Forge beyond loading its configuration and answering a verification check.
 * It activates ONLY when the page is opened with a live-test token that the
 * owner just generated in the builder — the ordinary runtime never polls.
 *
 * What it does: takes a queued tool name and arguments, executes them through
 * the browser's real `document.modelContext.executeTool`, and posts the actual
 * result back. It does not read the DOM itself and it does not shortcut to the
 * handler — if it did, the answer would not be WebMCP execution and could not
 * honestly be described as one.
 */

export const LIVE_TEST_PARAM = "__wmf_live_test";

/** How long a test session may run before the page stops polling. */
const MAX_SESSION_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1200;

/** Bounds matching the server's, so an oversized result is trimmed here too. */
const MAX_RESULT_CHARS = 8000;

interface RelayCommand {
  commandId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/**
 * Reads and immediately strips the live-test token from the visible URL.
 *
 * Same reasoning as the verification challenge: a token left in the address bar
 * can be bookmarked, shared, or leaked through a Referer header.
 */
export function takeLiveTestToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get(LIVE_TEST_PARAM);
  if (!token) return null;

  try {
    params.delete(LIVE_TEST_PARAM);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  } catch {
    // A page that forbids history manipulation can still run the test.
  }

  return token;
}

interface PostOutcome {
  body: Record<string, unknown> | null;
  /** True when the server said this session is over and polling must stop. */
  terminal: boolean;
}

/**
 * Statuses that mean "this session is finished", not "nothing yet".
 *
 * 410 expired, 404 closed/unknown, 403 wrong origin. Treating these as a
 * transient empty poll is what kept a dead session hammering the endpoint
 * every 1.2s until its five-minute ceiling.
 */
const TERMINAL_STATUSES = new Set([403, 404, 409, 410]);

async function post(
  forgeOrigin: string,
  payload: Record<string, unknown>,
): Promise<PostOutcome> {
  try {
    const response = await fetch(`${forgeOrigin}/api/public/live-test`, {
      method: "POST",
      credentials: "omit",
      mode: "cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { body: null, terminal: TERMINAL_STATUSES.has(response.status) };
    }
    return { body: (await response.json()) as Record<string, unknown>, terminal: false };
  } catch {
    // Network blip: keep trying until the session's own time limit.
    return { body: null, terminal: false };
  }
}

function asCommand(value: unknown): RelayCommand | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.commandId !== "string" || typeof raw.tool !== "string") return null;
  return {
    commandId: raw.commandId,
    tool: raw.tool,
    arguments:
      raw.arguments && typeof raw.arguments === "object"
        ? (raw.arguments as Record<string, unknown>)
        : {},
  };
}

export interface LiveTestHandle {
  stop: () => void;
}

/**
 * Runs the relay loop for one session.
 *
 * Each command is executed at most once on this side too: the server hands a
 * command out only once, and a result is posted exactly once per command, so a
 * dropped response cannot cause a re-run.
 */
export function startLiveTest(
  forgeOrigin: string,
  siteId: string,
  token: string,
): LiveTestHandle {
  let stopped = false;
  const startedAt = Date.now();

  const stop = () => {
    stopped = true;
  };

  void (async () => {
    const registered = await listRegisteredTools();

    const ready = await post(forgeOrigin, {
      action: "ready",
      siteId,
      token,
      runtimeVersion: "1.0.0",
      availableTools: registered.map((tool) => tool.name),
    });
    if (!ready.body) return; // rejected origin, expired token, or unreachable

    while (!stopped && Date.now() - startedAt < MAX_SESSION_MS) {
      const polled = await post(forgeOrigin, { action: "poll", siteId, token });
      if (polled.terminal) {
        // Session closed or expired. Stop rather than polling out the clock.
        stopped = true;
        break;
      }
      const command = polled.body ? asCommand(polled.body.command) : null;

      if (!command) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      // Genuine agent-path invocation: the browser looks the tool up in its own
      // registry and drives it. Not a direct call to our handler.
      const outcome = await executeRegisteredTool(command.tool, command.arguments);

      if (outcome === null) {
        await post(forgeOrigin, {
          action: "result",
          siteId,
          token,
          commandId: command.commandId,
          errorCode: "executeTool_unsupported",
        });
      } else if (outcome.ok) {
        // `rawResult` is exactly what the browser returned. The relay forwards
        // that verbatim rather than the parsed form, so the server sees the
        // real tool output rather than our re-serialization of it.
        await post(forgeOrigin, {
          action: "result",
          siteId,
          token,
          commandId: command.commandId,
          result: outcome.rawResult.slice(0, MAX_RESULT_CHARS),
        });
      } else {
        await post(forgeOrigin, {
          action: "result",
          siteId,
          token,
          commandId: command.commandId,
          // A coarse reason only; never a stack trace.
          errorCode: outcome.message.slice(0, 200),
        });
      }
    }
  })();

  return { stop };
}
