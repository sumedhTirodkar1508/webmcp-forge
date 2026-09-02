"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { CapabilityId } from "@/lib/capabilities/catalogue";
import type { BuilderState } from "@/lib/services/types";
import { buildBuilderTools, type BuilderActions } from "@/lib/webmcp/builder-tools";
import {
  checkWebMcpAvailability,
  registerTools,
  type WebMcpAvailability,
} from "@/lib/webmcp/client";

/**
 * The builder's single source of truth.
 *
 * Every mutation — whether it came from a button or from a WebMCP tool call —
 * goes through the same `actions` object here, hits the same API route, and
 * lands back as the same `BuilderState`. That is what makes "use WebMCP to
 * build WebMCP" real rather than theatre: the UI updates after an agent's tool
 * call because there is only one state, not because anything is being animated
 * to look busy.
 */

type Phase = "idle" | "targeting" | "scanning" | "saving" | "publishing" | "verifying";

interface BuilderContextValue {
  state: BuilderState;
  phase: Phase;
  error: string | null;
  webmcp: WebMcpAvailability;
  /** Tool names the browser accepted from this page. */
  registeredTools: string[];
  actions: BuilderActions;
  /** Highlights whichever part of the UI an agent just changed. */
  lastChanged: string | null;
  dismissError: () => void;
}

const BuilderContext = createContext<BuilderContextValue | null>(null);

/**
 * WebMCP availability, read through `useSyncExternalStore`.
 *
 * Feature detection has to happen in the browser, but the value never changes
 * for the lifetime of the page, so it is computed once and cached. Caching is
 * not an optimisation here: `getSnapshot` must return a referentially stable
 * value or React re-renders forever. The server snapshot reports unavailable,
 * which is the truthful answer during SSR and avoids a hydration mismatch.
 */
const SERVER_AVAILABILITY: WebMcpAvailability = {
  available: false,
  reason: "not_a_browser",
};

let cachedAvailability: WebMcpAvailability | null = null;

function clientAvailability(): WebMcpAvailability {
  cachedAvailability ??= checkWebMcpAvailability();
  return cachedAvailability;
}

/** Availability is fixed per page load, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {};
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Something went wrong. Please try again.");
  }
  return payload;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as T & {
    error?: { code: string; message: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? "Something went wrong. Please try again.");
  }
  return payload;
}

export function BuilderProvider({
  initialState,
  children,
}: {
  initialState: BuilderState;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<BuilderState>(initialState);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastChanged, setLastChanged] = useState<string | null>(null);
  const [registeredTools, setRegisteredTools] = useState<string[]>([]);

  const webmcp = useSyncExternalStore(
    subscribeToNothing,
    clientAvailability,
    () => SERVER_AVAILABILITY,
  );

  // Tool handlers must read the *current* state, not the state captured when
  // they were registered — tools are registered once and live for the whole
  // session. The ref is synced in an effect rather than during render; tool
  // handlers only ever run after commit, so they never see a stale value.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const flash = useCallback((section: string) => {
    setLastChanged(section);
    window.setTimeout(() => setLastChanged((current) => (current === section ? null : current)), 1800);
  }, []);

  const requireSiteId = useCallback((): string => {
    const siteId = stateRef.current.siteId;
    if (!siteId) throw new Error("Set a portfolio address first.");
    return siteId;
  }, []);

  const run = useCallback(
    async <T,>(next: Phase, section: string, work: () => Promise<T>): Promise<T> => {
      setPhase(next);
      setError(null);
      try {
        const result = await work();
        flash(section);
        return result;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Something went wrong.";
        setError(message);
        throw cause;
      } finally {
        setPhase("idle");
      }
    },
    [flash],
  );

  const actions = useMemo<BuilderActions>(
    () => ({
      getState: () => stateRef.current,

      setTargetUrl: (url) =>
        run("targeting", "target", async () => {
          const next = await postJson<BuilderState>("/api/builder/target", {
            url,
            siteId: stateRef.current.siteId ?? undefined,
          });
          setState(next);
          return next;
        }),

      scan: () =>
        run("scanning", "discovery", async () => {
          const next = await postJson<BuilderState>("/api/builder/scan", {
            siteId: requireSiteId(),
          });
          setState(next);
          return next;
        }),

      setCapabilityEnabled: (id: CapabilityId, enabled: boolean) =>
        run("saving", `capability:${id}`, async () => {
          const result = await postJson<{
            state: BuilderState;
            applied: boolean;
            message?: string;
          }>("/api/builder/capabilities", {
            siteId: requireSiteId(),
            capabilityId: id,
            enabled,
          });
          setState(result.state);
          return result;
        }),

      generateInstallation: () =>
        run("publishing", "install", async () => {
          const result = await postJson<{ state: BuilderState }>("/api/builder/publish", {
            siteId: requireSiteId(),
          });
          setState(result.state);
          return result.state;
        }),

      startVerification: () =>
        run("verifying", "verify", () =>
          postJson<{ verifyUrl: string }>("/api/builder/verify/start", {
            siteId: requireSiteId(),
          }),
        ),

      refreshState: async () => {
        const siteId = requireSiteId();
        const next = await getJson<BuilderState>(
          `/api/builder/state?siteId=${encodeURIComponent(siteId)}`,
        );
        setState(next);
        flash("verify");
        return next;
      },
    }),
    [flash, run, requireSiteId],
  );

  // Register the builder's own WebMCP tools, once, against the real browser API.
  useEffect(() => {
    if (!webmcp.available) return;

    const controller = new AbortController();
    let dispose: (() => void) | null = null;

    void registerTools(buildBuilderTools(actions), { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) {
          result.dispose();
          return;
        }
        dispose = result.dispose;
        setRegisteredTools(result.registered);
      },
    );

    return () => {
      controller.abort();
      dispose?.();
    };
  }, [actions, webmcp.available]);

  const value = useMemo<BuilderContextValue>(
    () => ({
      state,
      phase,
      error,
      webmcp,
      registeredTools,
      actions,
      lastChanged,
      dismissError: () => setError(null),
    }),
    [state, phase, error, webmcp, registeredTools, actions, lastChanged],
  );

  return <BuilderContext.Provider value={value}>{children}</BuilderContext.Provider>;
}

export function useBuilder(): BuilderContextValue {
  const context = useContext(BuilderContext);
  if (!context) throw new Error("useBuilder must be used inside a BuilderProvider");
  return context;
}
