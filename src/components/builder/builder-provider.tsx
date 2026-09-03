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
  /** Whether a live WebMCP test target is currently connected. */
  liveTest: LiveTestState;
  chat: ChatTurn[];
  askAgent: (question: string) => Promise<void>;
  startLiveTest: () => Promise<void>;
  stopLiveTest: () => Promise<void>;
  refreshLiveTest: () => Promise<void>;
}

export interface LiveTestState {
  connected: boolean;
  expiresAt: string | null;
  availableTools: string[];
  starting: boolean;
}

export interface ChatTurn {
  id: string;
  question: string;
  answer: string;
  /** "live" only when a real executeTool call happened on the portfolio. */
  mode: "readiness" | "live" | "live_unavailable" | "error";
  tool: string | null;
  executedOn: string | null;
  questionsRemaining: number | null;
  pending: boolean;
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
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [liveTest, setLiveTest] = useState<LiveTestState>({
    connected: false,
    expiresAt: null,
    availableTools: [],
    starting: false,
  });

  const webmcp = useSyncExternalStore(
    subscribeToNothing,
    clientAvailability,
    () => SERVER_AVAILABILITY,
  );

  /*
   * The mirror of `state` that async work reads.
   *
   * This used to be synced in an effect, which quietly broke every chained
   * action: `await setTargetUrl(); await scan();` runs before React commits, so
   * `scan` still read the PREVIOUS site id and scanned the site the user had
   * just navigated away from — then overwrote the screen with that site's
   * results. Updating the ref in the same tick as `setState`, through
   * `applyState`, is what makes a chained action see what just happened.
   *
   * Writing a ref from an event handler or async callback is fine; only
   * writing one *during render* is not.
   */
  const stateRef = useRef(state);

  /**
   * Identifies the currently selected site for in-flight work.
   *
   * Bumped whenever the site changes, so a slow response for the previous site
   * can be recognised and discarded instead of overwriting the new one.
   */
  const siteEpochRef = useRef(0);

  const applyState = useCallback((next: BuilderState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * Applies a result only if it still belongs to the site on screen.
   *
   * Returns false when the user switched sites while the request was in
   * flight; the caller should treat that as "discarded", not as a failure.
   */
  const applyIfCurrent = useCallback(
    (epoch: number, next: BuilderState): boolean => {
      if (epoch !== siteEpochRef.current) return false;
      applyState(next);
      return true;
    },
    [applyState],
  );

  /** True while the given epoch is still the selected site. */
  const isCurrentEpoch = useCallback((epoch: number) => epoch === siteEpochRef.current, []);

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
          const previousSiteId = stateRef.current.siteId;
          const next = await postJson<BuilderState>("/api/builder/target", {
            url,
            siteId: previousSiteId ?? undefined,
          });

          // Pointing the builder at a different origin selects a DIFFERENT
          // site, with its own scan, config, verification and quota. Anything
          // belonging to the previous site would be stale and misleading here,
          // and any request still in flight for it must be discarded.
          if (next.siteId !== previousSiteId) {
            siteEpochRef.current += 1;
            setChat([]);
            setLiveTest({
              connected: false,
              expiresAt: null,
              availableTools: [],
              starting: false,
            });
          }

          applyState(next);
          return next;
        }),

      // Every site-scoped action takes the site id explicitly, defaulting to
      // the current one. A caller that just changed the target passes the id it
      // was handed rather than hoping React has re-rendered.
      scan: (siteId) =>
        run("scanning", "discovery", async () => {
          const targetSiteId = siteId ?? requireSiteId();
          const epoch = siteEpochRef.current;
          const next = await postJson<BuilderState>("/api/builder/scan", {
            siteId: targetSiteId,
          });
          applyIfCurrent(epoch, next);
          return next;
        }),

      setCapabilityEnabled: (id: CapabilityId, enabled: boolean, siteId?: string) =>
        run("saving", `capability:${id}`, async () => {
          const targetSiteId = siteId ?? requireSiteId();
          const epoch = siteEpochRef.current;
          const result = await postJson<{
            state: BuilderState;
            applied: boolean;
            message?: string;
          }>("/api/builder/capabilities", {
            siteId: targetSiteId,
            capabilityId: id,
            enabled,
          });
          applyIfCurrent(epoch, result.state);
          return result;
        }),

      generateInstallation: (siteId) =>
        run("publishing", "install", async () => {
          const targetSiteId = siteId ?? requireSiteId();
          const epoch = siteEpochRef.current;
          const result = await postJson<{ state: BuilderState }>("/api/builder/publish", {
            siteId: targetSiteId,
          });
          applyIfCurrent(epoch, result.state);
          return result.state;
        }),

      startVerification: (siteId) =>
        run("verifying", "verify", () =>
          postJson<{ verifyUrl: string }>("/api/builder/verify/start", {
            siteId: siteId ?? requireSiteId(),
          }),
        ),

      refreshState: async (siteId) => {
        const targetSiteId = siteId ?? requireSiteId();
        const epoch = siteEpochRef.current;
        const next = await getJson<BuilderState>(
          `/api/builder/state?siteId=${encodeURIComponent(targetSiteId)}`,
        );
        if (applyIfCurrent(epoch, next)) flash("verify");
        return next;
      },
    }),
    [flash, run, requireSiteId, applyState, applyIfCurrent],
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

  /**
   * Refreshes whether a live test target is connected.
   *
   * Polled from the builder side only while a test is running; there is no
   * background polling when the panel is idle.
   */
  const refreshLiveTest = useCallback(async () => {
    const siteId = stateRef.current.siteId;
    if (!siteId) return;
    const epoch = siteEpochRef.current;
    try {
      const response = await fetch(
        `/api/builder/live-test?siteId=${encodeURIComponent(siteId)}`,
      );
      if (!response.ok) return;
      const next = (await response.json()) as {
        connected: boolean;
        expiresAt: string | null;
        availableTools: string[];
      };
      // A READY event for the demo must never light up production's panel.
      if (!isCurrentEpoch(epoch)) return;
      setLiveTest((current) => ({ ...current, ...next, starting: false }));
    } catch {
      // A failed poll is not worth surfacing; the next one may succeed.
    }
  }, [isCurrentEpoch]);

  /** Opens the owner's portfolio in a new tab with a one-time test token. */
  const startLive = useCallback(async () => {
    const siteId = stateRef.current.siteId;
    if (!siteId) return;
    const epoch = siteEpochRef.current;

    setLiveTest((current) => ({ ...current, starting: true }));
    try {
      const { testUrl } = await postJson<{ testUrl: string }>("/api/builder/live-test", {
        siteId,
      });
      // The user may have switched sites while the session was being opened.
      if (!isCurrentEpoch(epoch)) return;
      window.open(testUrl, "_blank", "noopener,noreferrer");
    } catch (cause) {
      if (!isCurrentEpoch(epoch)) return;
      setLiveTest((current) => ({ ...current, starting: false }));
      setError(cause instanceof Error ? cause.message : "Could not start the live test.");
    }
  }, [isCurrentEpoch]);

  const stopLive = useCallback(async () => {
    const siteId = stateRef.current.siteId;
    if (!siteId) return;
    try {
      await postJson("/api/builder/live-test", { siteId, action: "stop" });
    } finally {
      setLiveTest({ connected: false, expiresAt: null, availableTools: [], starting: false });
    }
  }, []);

  /**
   * Asks the readiness assistant a question.
   *
   * The turn is added optimistically as pending so the transcript stays
   * readable, then replaced with the real answer — including whether a genuine
   * tool call happened, which the UI must not overstate.
   */
  const askAgent = useCallback(
    async (question: string) => {
      const siteId = stateRef.current.siteId;
      if (!siteId) return;
      const epoch = siteEpochRef.current;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setChat((current) => [
        ...current,
        {
          id,
          question,
          answer: "",
          mode: "readiness",
          tool: null,
          executedOn: null,
          questionsRemaining: null,
          pending: true,
        },
      ]);

      try {
        const result = await postJson<{
          mode: ChatTurn["mode"];
          answer: string;
          tool: string | null;
          executed: boolean;
          executedOn: string | null;
          questionsRemaining: number;
        }>("/api/builder/demo", { siteId, question });

        // An answer about the demo must never be shown as if it described
        // production. The transcript is cleared on switch, so simply dropping
        // it is correct.
        if (!isCurrentEpoch(epoch)) return;

        setChat((current) =>
          current.map((turn) =>
            turn.id === id
              ? {
                  ...turn,
                  answer: result.answer,
                  mode: result.mode,
                  tool: result.tool,
                  executedOn: result.executed ? result.executedOn : null,
                  questionsRemaining: result.questionsRemaining,
                  pending: false,
                }
              : turn,
          ),
        );
      } catch (cause) {
        if (!isCurrentEpoch(epoch)) return;
        setChat((current) =>
          current.map((turn) =>
            turn.id === id
              ? {
                  ...turn,
                  answer:
                    cause instanceof Error ? cause.message : "The assistant could not answer.",
                  mode: "error",
                  pending: false,
                }
              : turn,
          ),
        );
      }
    },
    [isCurrentEpoch],
  );

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
      liveTest,
      chat,
      askAgent,
      startLiveTest: startLive,
      stopLiveTest: stopLive,
      refreshLiveTest,
    }),
    [
      state,
      phase,
      error,
      webmcp,
      registeredTools,
      actions,
      lastChanged,
      liveTest,
      chat,
      askAgent,
      startLive,
      stopLive,
      refreshLiveTest,
    ],
  );

  return <BuilderContext.Provider value={value}>{children}</BuilderContext.Provider>;
}

export function useBuilder(): BuilderContextValue {
  const context = useContext(BuilderContext);
  if (!context) throw new Error("useBuilder must be used inside a BuilderProvider");
  return context;
}
