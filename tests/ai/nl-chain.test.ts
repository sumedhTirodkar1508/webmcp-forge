import { describe, expect, it, vi } from "vitest";

import { runModelChain } from "@/lib/ai/model-chain";

/**
 * The natural-language model chain.
 *
 * Two models only — 3.5 Flash-Lite then 3.1 Flash-Lite — and never the
 * flagship scan model. This path is interactive, so the governing requirement
 * is that it stays bounded and fast: a timeout falls straight through to the
 * cheaper model rather than doubling the wait on one that has already run out
 * of budget.
 */

const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

const valid = { tool: "get_skills", arguments: {}, reasoning: "skills question" };

function ok() {
  return { ok: true as const, value: valid };
}

/** Runs the chain with sleeps stubbed out so tests do not actually wait. */
function run(call: (model: string, signal: AbortSignal) => Promise<unknown>, sleep = vi.fn(async () => {})) {
  return runModelChain<typeof valid>({
    models: MODELS,
    timeoutMs: 9000,
    maxRetriesPerModel: 1,
    call,
    validate: (raw) =>
      raw && typeof raw === "object" && "tool" in raw
        ? ok()
        : { ok: false as const, message: "invalid shape" },
    sleep,
    random: () => 0,
  });
}

function httpError(status: number, message = "boom") {
  return Object.assign(new Error(message), { status });
}

describe("the natural-language chain", () => {
  it("answers from the primary model without touching the fallback", async () => {
    const call = vi.fn(async () => valid);
    const result = await run(call);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(result.fellBack).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never reaches for the flagship scan model", async () => {
    const seen: string[] = [];
    await run(async (model) => {
      seen.push(model);
      throw httpError(500);
    });

    expect(seen.every((model) => model.endsWith("-lite"))).toBe(true);
    expect(seen).not.toContain("gemini-3.7-flash");
  });

  it("falls straight through to 3.1 on a timeout, without retrying 3.5", async () => {
    const seen: string[] = [];
    const sleep = vi.fn(async () => {});
    const result = await run(async (model) => {
      seen.push(model);
      if (model === "gemini-3.5-flash-lite") {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return valid;
    }, sleep);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("gemini-3.1-flash-lite");
    expect(result.fellBack).toBe(true);
    // Exactly one attempt on the primary — a timed-out model has already used
    // its whole latency budget.
    expect(seen.filter((m) => m === "gemini-3.5-flash-lite")).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a temporary 5xx once on the same model before falling back", async () => {
    const seen: string[] = [];
    let calls = 0;
    const result = await run(async (model) => {
      seen.push(model);
      calls += 1;
      if (calls === 1) throw httpError(503);
      return valid;
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(seen).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
  });

  it("moves to the fallback immediately when the primary's quota is gone", async () => {
    const seen: string[] = [];
    const sleep = vi.fn(async () => {});
    const result = await run(async (model) => {
      seen.push(model);
      if (model === "gemini-3.5-flash-lite") {
        throw httpError(429, "You have exceeded your current quota");
      }
      return valid;
    }, sleep);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("gemini-3.1-flash-lite");
    expect(seen.filter((m) => m === "gemini-3.5-flash-lite")).toHaveLength(1);
    // Quota exhaustion is not worth waiting out.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops the whole chain on an auth error rather than burning the fallback", async () => {
    const seen: string[] = [];
    const result = await run(async (model) => {
      seen.push(model);
      throw httpError(401, "API key not valid");
    });

    expect(result.ok).toBe(false);
    // A bad key fails identically on every model.
    expect(seen).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("stops on a malformed request without trying the fallback", async () => {
    const seen: string[] = [];
    await run(async (model) => {
      seen.push(model);
      throw httpError(400, "Invalid JSON payload");
    });
    expect(seen).toEqual(["gemini-3.5-flash-lite"]);
  });

  it("gives structured-output failures one corrective retry, then falls back", async () => {
    const seen: string[] = [];
    const result = await run(async (model) => {
      seen.push(model);
      if (model === "gemini-3.5-flash-lite") return { nonsense: true };
      return valid;
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("gemini-3.1-flash-lite");
    // One initial attempt plus exactly one corrective retry on the primary.
    expect(seen.filter((m) => m === "gemini-3.5-flash-lite")).toHaveLength(2);
  });

  it("fails cleanly and stays bounded when both models fail", async () => {
    const seen: string[] = [];
    const result = await run(async (model) => {
      seen.push(model);
      throw httpError(500);
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts.length).toBeLessThanOrEqual(3 * MODELS.length);
    // Roughly two attempts per model keeps the interactive path fast.
    expect(seen.filter((m) => m === "gemini-3.5-flash-lite")).toHaveLength(2);
    expect(seen.filter((m) => m === "gemini-3.1-flash-lite")).toHaveLength(2);
  });

  it("records every attempt so the ledger can distinguish them", async () => {
    const attempts: string[] = [];
    await runModelChain<typeof valid>({
      models: MODELS,
      timeoutMs: 9000,
      maxRetriesPerModel: 1,
      call: async (model) => {
        if (model === "gemini-3.5-flash-lite") throw httpError(503);
        return valid;
      },
      validate: () => ok(),
      onAttempt: (record) => {
        attempts.push(`${record.model}:${record.status}`);
      },
      sleep: async () => {},
      random: () => 0,
    });

    expect(attempts).toContain("gemini-3.1-flash-lite:SUCCESS");
    expect(attempts.filter((a) => a.endsWith(":SUCCESS"))).toHaveLength(1);
  });
});
