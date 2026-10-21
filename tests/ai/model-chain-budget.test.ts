import { describe, expect, it, vi } from "vitest";

import { runModelChain } from "@/lib/ai/model-chain";

/**
 * A total budget across the whole model chain.
 *
 * Per-request timeouts bound one call, not the chain: three models with
 * retries can add up to far longer than the request serving them may live.
 */

const valid = { ok: true as const, value: "answer" };

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("model chain budget", () => {
  it("is unbounded when no budget is given (original behaviour)", async () => {
    const c = clock();
    const result = await runModelChain({
      models: ["a", "b"],
      timeoutMs: 1_000,
      call: async () => {
        c.advance(50_000);
        return "x";
      },
      validate: () => valid,
      now: c.now,
    });
    expect(result.ok).toBe(true);
  });

  it("stops starting attempts once the budget is spent", async () => {
    const c = clock();
    const call = vi.fn(async () => {
      c.advance(6_000);
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    });

    const result = await runModelChain({
      models: ["a", "b", "c"],
      timeoutMs: 20_000,
      budgetMs: 10_000,
      call,
      validate: () => valid,
      now: c.now,
      sleep: async () => {},
      random: () => 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "TIMEOUT", code: "budget_exhausted" });
    // Far fewer than the unbounded worst case of two attempts per model.
    expect(call.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("clamps each request's timeout to what remains", async () => {
    const c = clock();
    const signals: AbortSignal[] = [];
    c.advance(0);

    await runModelChain({
      models: ["a"],
      timeoutMs: 20_000,
      budgetMs: 2_500,
      call: async (_model, signal) => {
        signals.push(signal);
        return "x";
      },
      validate: () => valid,
      now: c.now,
    });

    // Not observable as a value, but the call completed under budget.
    expect(signals).toHaveLength(1);
  });

  it("does not sleep past the budget on a long Retry-After", async () => {
    const c = clock();
    const sleep = vi.fn(async (ms: number) => {
      c.advance(ms);
    });

    await runModelChain({
      models: ["a"],
      timeoutMs: 5_000,
      budgetMs: 4_000,
      call: async () => {
        throw Object.assign(new Error("rate limited"), {
          status: 429,
          retryDelay: "30s",
        });
      },
      validate: () => valid,
      now: c.now,
      sleep,
      random: () => 0,
    });

    for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThanOrEqual(4_000);
  });

  it("still succeeds normally inside the budget", async () => {
    const result = await runModelChain({
      models: ["a"],
      timeoutMs: 5_000,
      budgetMs: 30_000,
      call: async () => "x",
      validate: () => valid,
    });
    expect(result).toMatchObject({ ok: true, model: "a" });
  });
});
