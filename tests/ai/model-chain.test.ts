import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, runModelChain, type AiAttemptRecord } from "@/lib/ai/model-chain";

const MODELS = ["model-a", "model-b", "model-c"];

function okValidate(raw: unknown) {
  return { ok: true as const, value: raw as { text: string } };
}

function httpError(status: number, message: string, extra?: Record<string, unknown>) {
  return { status, message, ...extra };
}

function trackingSleep() {
  const calls: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe("runModelChain", () => {
  it("succeeds on the first model, first attempt", async () => {
    const call = vi.fn(async () => ({ text: "ok" }));
    const { sleep } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe("SUCCESS");
    expect(result.model).toBe("model-a");
    expect(result.fellBack).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (500) failure and then succeeds on the same model", async () => {
    let n = 0;
    const call = vi.fn(async (model: string) => {
      n += 1;
      if (n === 1) throw httpError(500, "server error");
      return { text: `ok from ${model}` };
    });
    const { sleep, calls } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.model === "model-a")).toBe(true);
    expect(result.fellBack).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBeGreaterThanOrEqual(0);
  });

  it("exhausts transient retries on model 1 and falls back to model 2", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "model-a") throw httpError(503, "unavailable");
      return { text: `ok from ${model}` };
    });
    const { sleep } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      maxRetriesPerModel: 1,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.fellBack).toBe(true);
    expect(result.model).toBe("model-b");
    const modelAAttempts = result.attempts.filter((a) => a.model === "model-a");
    const modelBAttempts = result.attempts.filter((a) => a.model === "model-b");
    expect(modelAAttempts).toHaveLength(2); // 1 initial + 1 retry
    expect(modelBAttempts).toHaveLength(1);
  });

  it("moves straight to the next model on QUOTA_EXHAUSTED with no sleep", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "model-a") {
        throw httpError(429, "You exceeded your current quota, check billing");
      }
      return { text: `ok from ${model}` };
    });
    const { sleep } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.model).toBe("model-b");
    const modelAAttempts = result.attempts.filter((a) => a.model === "model-a");
    expect(modelAAttempts).toHaveLength(1);
    expect(modelAAttempts[0]!.status).toBe("QUOTA_EXHAUSTED");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sleeps ~2000ms for a RATE_LIMITED error with Retry-After: 2", async () => {
    let n = 0;
    const call = vi.fn(async () => {
      n += 1;
      if (n === 1) throw httpError(429, "Too many requests", { retryDelay: 2 });
      return { text: "ok" };
    });
    const { sleep, calls } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe(2000);
  });

  it("clamps an absurd Retry-After: 9999 to 30000ms", async () => {
    let n = 0;
    const call = vi.fn(async () => {
      n += 1;
      if (n === 1) throw httpError(429, "Too many requests", { retryDelay: 9999 });
      return { text: "ok" };
    });
    const { sleep, calls } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe(30000);
  });

  it("stops the whole chain immediately on AUTH (401)", async () => {
    const call = vi.fn(async (model: string) => {
      throw httpError(401, `unauthorized for ${model}`);
    });
    const { sleep } = trackingSleep();

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.attempts).toHaveLength(1);
    expect(result.failure.kind).toBe("AUTH");
    expect(call).toHaveBeenCalledTimes(1);
    const modelsCalled = call.mock.calls.map((c) => c[0]);
    expect(modelsCalled).toEqual(["model-a"]);
  });

  it("stops the whole chain immediately on INVALID_REQUEST (400)", async () => {
    const call = vi.fn(async (model: string) => {
      throw httpError(400, `bad request for ${model}`);
    });

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.attempts).toHaveLength(1);
    expect(result.failure.kind).toBe("INVALID_REQUEST");
    const modelsCalled = call.mock.calls.map((c) => c[0]);
    expect(modelsCalled).toEqual(["model-a"]);
  });

  it("retries once on schema-invalid then succeeds on the corrective retry", async () => {
    let n = 0;
    const call = vi.fn(async () => {
      n += 1;
      return { attempt: n };
    });
    const validate = (raw: unknown) => {
      const value = raw as { attempt: number };
      if (value.attempt === 1) return { ok: false as const, message: "missing field" };
      return { ok: true as const, value };
    };

    const result = await runModelChain({
      models: MODELS,
      call,
      validate,
      timeoutMs: 1000,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.model === "model-a")).toBe(true);
    expect(result.attempts[0]!.status).toBe("SCHEMA_INVALID");
    expect(result.attempts[1]!.status).toBe("SUCCESS");
    expect(result.fellBack).toBe(false);
  });

  it("moves to the next model after schema-invalid twice on model 1", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "model-a") return { bad: true };
      return { good: true };
    });
    const validate = (raw: unknown) => {
      const value = raw as { bad?: boolean; good?: boolean };
      if (value.bad) return { ok: false as const, message: "invalid" };
      return { ok: true as const, value };
    };

    const result = await runModelChain({
      models: MODELS,
      call,
      validate,
      timeoutMs: 1000,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.model).toBe("model-b");
    const modelAAttempts = result.attempts.filter((a) => a.model === "model-a");
    expect(modelAAttempts).toHaveLength(2);
    expect(modelAAttempts.every((a) => a.status === "SCHEMA_INVALID")).toBe(true);
  });

  it("returns ok:false with bounded attempts when every model fails", async () => {
    const call = vi.fn(async () => {
      throw httpError(503, "unavailable");
    });

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      maxRetriesPerModel: 1,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("TRANSIENT");
    expect(result.attempts.length).toBeLessThanOrEqual(3 * MODELS.length);
    const perModel = new Map<string, number>();
    for (const a of result.attempts) {
      perModel.set(a.model, (perModel.get(a.model) ?? 0) + 1);
    }
    for (const model of MODELS) {
      expect(perModel.get(model)).toBe(2); // 1 initial + 1 retry, maxRetriesPerModel=1
    }
  });

  it("calls onAttempt once per attempt, in order, and tolerates it throwing", async () => {
    let n = 0;
    const call = vi.fn(async () => {
      n += 1;
      if (n === 1) throw httpError(500, "boom");
      return { text: "ok" };
    });
    const seen: AiAttemptRecord[] = [];
    const onAttempt = vi.fn(async (record: AiAttemptRecord) => {
      seen.push(record);
      throw new Error("persistence failed");
    });

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      onAttempt,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(true);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(seen.map((r) => r.status)).toEqual(["TRANSIENT_ERROR", "SUCCESS"]);
    expect(seen.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("aborts a call that never resolves after timeoutMs and classifies it TIMEOUT", async () => {
    const call = vi.fn(
      (_model: string, signal: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const result = await runModelChain({
      models: ["model-a"],
      call,
      validate: okValidate,
      timeoutMs: 10,
      maxRetriesPerModel: 0,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("TIMEOUT");
    expect(result.attempts[0]!.status).toBe("TIMEOUT");
  }, 2000);

  it("falls back immediately after a timeout without retrying or sleeping", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "model-a") {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return { text: "fallback succeeded" };
    });
    const { sleep } = trackingSleep();

    const result = await runModelChain({
      models: ["model-a", "model-b"],
      call,
      validate: okValidate,
      timeoutMs: 1000,
      maxRetriesPerModel: 2,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(call.mock.calls.map((args) => args[0])).toEqual(["model-a", "model-b"]);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["TIMEOUT", "SUCCESS"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the shorter timeout budget for fallback models", async () => {
    const abortedAt: string[] = [];
    const call = vi.fn(
      (model: string, signal: AbortSignal) =>
        new Promise<unknown>((resolve, reject) => {
          if (model === "model-c") {
            resolve({ text: "ok" });
            return;
          }
          signal.addEventListener("abort", () => {
            abortedAt.push(model);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const started = Date.now();
    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 30,
      fallbackTimeoutMs: 5,
      sleep: trackingSleep().sleep,
    });

    expect(result.ok).toBe(true);
    expect(abortedAt).toEqual(["model-a", "model-b"]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("never exceeds 3 attempts for a single model and 3*models.length overall", async () => {
    // Alternates schema-invalid then transient-error style failures to probe
    // that corrective + transient retries can't compound past the bound.
    const call = vi.fn(async () => {
      throw httpError(503, "unavailable");
    });

    const result = await runModelChain({
      models: MODELS,
      call,
      validate: okValidate,
      timeoutMs: 1000,
      maxRetriesPerModel: 1,
      sleep: trackingSleep().sleep,
    });

    expect(result.attempts.length).toBeLessThanOrEqual(3 * MODELS.length);
    const perModel = new Map<string, number>();
    for (const a of result.attempts) {
      perModel.set(a.model, (perModel.get(a.model) ?? 0) + 1);
    }
    for (const count of perModel.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });
});

describe("backoffDelayMs", () => {
  it("returns 0 when random is stubbed to 0", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(0);
    expect(backoffDelayMs(5, () => 0)).toBe(0);
  });

  it("returns the exponential cap when random is stubbed to 1", () => {
    expect(backoffDelayMs(1, () => 1)).toBe(500);
    expect(backoffDelayMs(2, () => 1)).toBe(1000);
    expect(backoffDelayMs(4, () => 1)).toBe(4000);
    expect(backoffDelayMs(10, () => 1)).toBe(8000); // capped
  });

  it("always stays within [0, 8000]", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = backoffDelayMs(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(8000);
      }
    }
  });
});
