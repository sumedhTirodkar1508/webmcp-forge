import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateAiBudget } from "@/lib/ai/budget";
import { interpretScan } from "@/lib/ai/semantic";
import { resetEnvCache } from "@/lib/env";
import type { ScanRepresentation } from "@/lib/scanner/types";

/**
 * Once the deployment's AI budget is spent, scans must still work — using the
 * structural reading — and must not call the model at all.
 */

// If the budget stop failed and the code reached for the provider, this would
// fail the test loudly instead of making a network call.
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      throw new Error("the model must not be contacted when the AI budget is spent");
    }
  },
}));

const representation: ScanRepresentation = {
  origin: "https://x.test",
  entryUrl: "https://x.test/",
  platform: { platform: "CUSTOM", confidence: 0.5, evidence: [] },
  pages: [],
  routePatterns: [],
  navigation: [],
  failures: [],
  lowInformation: false,
};

describe("evaluateAiBudget", () => {
  it("is exhausted exactly when usage reaches the limit", () => {
    expect(evaluateAiBudget(100, 99).exhausted).toBe(false);
    expect(evaluateAiBudget(100, 100).exhausted).toBe(true);
    expect(evaluateAiBudget(100, 250).exhausted).toBe(true);
  });

  it("a limit of 0 turns the cap off", () => {
    expect(evaluateAiBudget(0, 0).exhausted).toBe(false);
    expect(evaluateAiBudget(0, 1_000_000).exhausted).toBe(false);
  });
});

describe("interpretScan with the AI budget spent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("uses the structural reading and says why, without contacting the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    resetEnvCache();

    const outcome = await interpretScan(representation, { skipAi: true });

    expect(outcome.usedAi).toBe(false);
    expect(outcome.model).toBeNull();
    expect(outcome.attempts).toEqual([]);
    expect(outcome.warnings[0]).toMatch(/daily limit/i);
  });

  it("with no key configured, reports that instead of blaming the budget", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    resetEnvCache();

    const outcome = await interpretScan(representation, { skipAi: true });

    expect(outcome.usedAi).toBe(false);
    expect(outcome.warnings[0]).toMatch(/not configured/i);
  });
});
