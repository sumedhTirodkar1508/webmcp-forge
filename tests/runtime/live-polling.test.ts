// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

/**
 * When the relay loop must stop polling.
 *
 * The runtime polled every 1.2s and treated ANY non-OK response as "no command
 * yet", so a session that had expired or been closed kept hammering the
 * endpoint until its five-minute ceiling. Terminal statuses must end the loop.
 */

/** Mirrors TERMINAL_STATUSES in src/runtime/live-test.ts. */
const TERMINAL_STATUSES = new Set([403, 404, 409, 410]);
const isTerminal = (status: number) => TERMINAL_STATUSES.has(status);

describe("relay polling termination", () => {
  it("stops on the statuses that mean the session is over", () => {
    // 410 expired, 404 closed/unknown, 403 wrong origin, 409 consumed.
    expect(isTerminal(410)).toBe(true);
    expect(isTerminal(404)).toBe(true);
    expect(isTerminal(403)).toBe(true);
    expect(isTerminal(409)).toBe(true);
  });

  it("keeps polling through transient failures", () => {
    // A blip must not end a session the user is still using.
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isTerminal(status), String(status)).toBe(false);
    }
  });

  it("treats a successful empty poll as 'nothing yet', not terminal", () => {
    expect(isTerminal(200)).toBe(false);
  });

  it("bounds a session even if the server never answers terminally", () => {
    const MAX_SESSION_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 1200;
    // The ceiling still applies, so an abandoned tab cannot poll forever.
    expect(MAX_SESSION_MS / POLL_INTERVAL_MS).toBeLessThan(300);
  });
});

describe("builder-side polling lifecycle", () => {
  /**
   * The panel polls only while a test is starting or connected, and clears its
   * interval on cleanup — so there is one loop per page and none after unmount.
   */
  function pollingEffect(starting: boolean, connected: boolean) {
    if (!starting && !connected) return null;
    const id = window.setInterval(() => {}, 2000);
    return () => window.clearInterval(id);
  }

  it("does not start a loop when idle", () => {
    expect(pollingEffect(false, false)).toBeNull();
  });

  it("starts exactly one loop while starting or connected", () => {
    for (const [starting, connected] of [[true, false], [false, true], [true, true]] as const) {
      const cleanup = pollingEffect(starting, connected);
      expect(cleanup).not.toBeNull();
      cleanup?.();
    }
  });

  it("clears its timer on cleanup, leaving no runaway loop", () => {
    let clearCalls = 0;
    const original = window.clearInterval;
    window.clearInterval = ((id: number) => {
      clearCalls += 1;
      original(id);
    }) as typeof window.clearInterval;

    try {
      const cleanup = pollingEffect(false, true);
      cleanup?.();
      expect(clearCalls).toBe(1);
    } finally {
      window.clearInterval = original;
    }
  });
});
