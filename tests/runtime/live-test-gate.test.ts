// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIVE_TEST_PARAM, takeLiveTestToken } from "@/runtime/live-test";

/**
 * The gate on live-test mode.
 *
 * The relay is the only thing that makes an installed portfolio talk to WebMCP
 * Forge repeatedly, so the property that matters most is that an ORDINARY page
 * view never activates it. A visitor reading someone's portfolio must generate
 * no traffic to Forge beyond the one configuration fetch.
 */

function setUrl(search: string): void {
  window.history.replaceState({}, "", `/work${search}`);
}

beforeEach(() => {
  setUrl("");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live-test activation", () => {
  it("returns no token for an ordinary page view", () => {
    expect(takeLiveTestToken()).toBeNull();
  });

  it("ignores unrelated query parameters", () => {
    setUrl("?utm_source=twitter&ref=hn");
    expect(takeLiveTestToken()).toBeNull();
    // Nothing of the visitor's URL is disturbed when the mode is not active.
    expect(window.location.search).toBe("?utm_source=twitter&ref=hn");
  });

  it("reads the token and strips it from the visible URL immediately", () => {
    const token = "a".repeat(43);
    setUrl(`?${LIVE_TEST_PARAM}=${token}`);

    expect(takeLiveTestToken()).toBe(token);
    // A token left in the address bar could be bookmarked, shared, or leaked
    // through a Referer header.
    expect(window.location.search).not.toContain(LIVE_TEST_PARAM);
    expect(window.location.search).not.toContain(token);
  });

  it("preserves the page's own query parameters when stripping", () => {
    const token = "b".repeat(43);
    setUrl(`?page=2&${LIVE_TEST_PARAM}=${token}&sort=recent`);

    expect(takeLiveTestToken()).toBe(token);
    expect(window.location.search).toContain("page=2");
    expect(window.location.search).toContain("sort=recent");
    expect(window.location.search).not.toContain(token);
  });

  it("only yields the token once, so a reload cannot re-arm the relay", () => {
    const token = "c".repeat(43);
    setUrl(`?${LIVE_TEST_PARAM}=${token}`);

    expect(takeLiveTestToken()).toBe(token);
    expect(takeLiveTestToken()).toBeNull();
  });
});
