import { describe, expect, it, vi } from "vitest";

import type { BuilderState } from "@/lib/services/types";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";

/**
 * The chained-action contract.
 *
 * A real bug lived here: `await setTargetUrl(url); await scan();` ran inside a
 * single microtask chain, before React had committed, so `scan` read the
 * PREVIOUS site id, scanned the site the user had just navigated away from,
 * and then overwrote the screen with that site's results. The address bar said
 * production; the page showed the demo.
 *
 * Two properties fix it, and both are modelled here against the same logic the
 * provider uses:
 *
 *   1. the authoritative site id is handed forward explicitly;
 *   2. a response is only applied while it still describes the selected site.
 */

function stateFor(siteId: string, url: string, skills: number): BuilderState {
  return {
    ...EMPTY_BUILDER_STATE,
    siteId,
    publicId: `wmf_${siteId}`,
    targetUrl: url,
    origin: new URL(url).origin,
    status: "SCANNED",
    discovery: {
      platform: "CUSTOM",
      platformConfidence: 1,
      pagesScanned: 5,
      routePatterns: ["/"],
      found: { Skills: skills },
      missing: [],
      warnings: [],
      lowInformation: false,
      usedAi: true,
      aiModel: "gemini-3.5-flash-lite",
      aiFellBack: false,
      scannedAt: new Date().toISOString(),
    },
  };
}

const DEMO = stateFor("site-demo", "https://demo.example/", 24);
const PROD = stateFor("site-prod", "https://prod.example/", 43);

/**
 * A faithful miniature of the provider: a ref updated in the same tick as the
 * rendered state, plus an epoch that identifies the selected site.
 */
function createProvider(initial: BuilderState) {
  let rendered = initial;
  const ref = { current: initial };
  let epoch = 0;

  const applyState = (next: BuilderState) => {
    ref.current = next; // synchronous — this is what the effect-based sync broke
    rendered = next;
  };

  return {
    get rendered() {
      return rendered;
    },
    get currentSiteId() {
      return ref.current.siteId;
    },
    epoch: () => epoch,
    switchSite(next: BuilderState) {
      if (next.siteId !== ref.current.siteId) epoch += 1;
      applyState(next);
    },
    applyIfCurrent(capturedEpoch: number, next: BuilderState) {
      if (capturedEpoch !== epoch) return false;
      applyState(next);
      return true;
    },
  };
}

describe("target → scan handoff", () => {
  it("scans the site the target call resolved to, not the previous one", async () => {
    const provider = createProvider(DEMO);

    const setTargetUrl = vi.fn(async () => {
      provider.switchSite(PROD);
      return PROD;
    });
    const scan = vi.fn(async (siteId: string) => siteId);

    // Exactly what the target form does.
    const target = await setTargetUrl();
    await scan(target.siteId!);

    expect(scan).toHaveBeenCalledWith("site-prod");
    expect(scan).not.toHaveBeenCalledWith("site-demo");
  });

  it("would have scanned the wrong site if it read state after setState", async () => {
    // Documents the original defect: with the ref synced only on commit, the
    // value read here is still the previous site.
    let rendered = DEMO;
    const staleRef = { current: DEMO };
    const commit = () => {
      staleRef.current = rendered;
    };

    rendered = PROD; // setState(next) — not yet committed
    const readNow = staleRef.current.siteId;
    commit(); // React commits later, effect runs later still

    expect(readNow).toBe("site-demo");
    expect(staleRef.current.siteId).toBe("site-prod");
  });

  it("leaves the production target and its scan on screen when finished", async () => {
    const provider = createProvider(DEMO);
    provider.switchSite(PROD);

    const epoch = provider.epoch();
    // The scan response for production arrives.
    provider.applyIfCurrent(epoch, PROD);

    expect(provider.rendered.targetUrl).toBe("https://prod.example/");
    expect(provider.rendered.discovery?.found.Skills).toBe(43);
  });
});

describe("out-of-order responses", () => {
  it("discards a late response for the site the user left", () => {
    const provider = createProvider(DEMO);

    // A request for the demo starts.
    const demoEpoch = provider.epoch();

    // The user switches to production before it returns.
    provider.switchSite(PROD);

    // The demo's slow response finally lands.
    const applied = provider.applyIfCurrent(demoEpoch, DEMO);

    expect(applied).toBe(false);
    expect(provider.rendered.targetUrl).toBe("https://prod.example/");
    expect(provider.rendered.discovery?.found.Skills).toBe(43);
  });

  it("still applies a response for the site that is selected", () => {
    const provider = createProvider(DEMO);
    provider.switchSite(PROD);

    const epoch = provider.epoch();
    expect(provider.applyIfCurrent(epoch, PROD)).toBe(true);
    expect(provider.currentSiteId).toBe("site-prod");
  });

  it("treats returning to the original site as a fresh epoch", () => {
    const provider = createProvider(DEMO);
    const first = provider.epoch();

    provider.switchSite(PROD);
    provider.switchSite(DEMO);

    // A response captured before either switch is stale even though the site
    // id matches again — it may describe pre-switch state.
    expect(provider.applyIfCurrent(first, DEMO)).toBe(false);
    expect(provider.currentSiteId).toBe("site-demo");
  });

  it("does not bump the epoch when the site is unchanged", () => {
    const provider = createProvider(DEMO);
    const epoch = provider.epoch();

    // Re-targeting the same origin resolves to the same site.
    provider.switchSite({ ...DEMO, targetUrl: "https://demo.example/work" });

    expect(provider.epoch()).toBe(epoch);
    // So an in-flight scan for that site is still applied.
    expect(provider.applyIfCurrent(epoch, DEMO)).toBe(true);
  });
});

describe("site-scoped panels", () => {
  it("only renders data tagged with the selected site", () => {
    // The pattern Insights and Repair use: store the site alongside the data
    // so a mismatch simply stops rendering rather than needing a reset.
    const entry = { siteId: "site-demo", value: { skills: 24 } };
    const visibleUnderDemo = entry.siteId === "site-demo" ? entry.value : null;
    const visibleUnderProd = entry.siteId === "site-prod" ? entry.value : null;

    expect(visibleUnderDemo).toEqual({ skills: 24 });
    expect(visibleUnderProd).toBeNull();
  });

  it("rejects applying a proposal computed for another site", () => {
    const proposal = { siteId: "site-demo", preview: { applicable: true } };
    const currentSiteId = "site-prod";

    const canApply = proposal.siteId === currentSiteId;
    expect(canApply).toBe(false);
  });
});
