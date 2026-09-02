/**
 * Executes a request against an ordered chain of Gemini models, retrying
 * transient failures on the same model before falling back to the next one.
 *
 * Configuration is passed in by the caller (see `RunModelChainOptions`) so
 * this module has no dependency on `@/lib/env` and can be unit tested with
 * no environment configured at all.
 */

import { logger } from "@/lib/logger";
import { classifyAiError, type AiFailure } from "@/lib/ai/classify-error";

export interface AiAttemptRecord {
  model: string;
  attempt: number; // 1-based within that model
  status:
    | "SUCCESS"
    | "TRANSIENT_ERROR"
    | "RATE_LIMITED"
    | "QUOTA_EXHAUSTED"
    | "AUTH_ERROR"
    | "INVALID_REQUEST"
    | "SCHEMA_INVALID"
    | "TIMEOUT"
    | "UNKNOWN_ERROR";
  errorCode?: string;
  latencyMs: number;
}

export interface RunModelChainOptions<T> {
  models: string[]; // ordered: primary, fallback1, fallback2
  /** Performs ONE request against ONE model. Throws on transport/API failure. */
  call: (model: string, signal: AbortSignal) => Promise<unknown>;
  /** Validates the raw response. Return {ok:true,value} or {ok:false,message}. */
  validate: (raw: unknown) => { ok: true; value: T } | { ok: false; message: string };
  timeoutMs: number;
  /** Optional shorter request budget for backup models. */
  fallbackTimeoutMs?: number;
  /** Transient retries allowed per model, from GEMINI_MAX_RETRIES_PER_MODEL. Default 1. */
  maxRetriesPerModel?: number;
  /** Called after every attempt so the caller can persist an ai_usage_event. */
  onAttempt?: (record: AiAttemptRecord) => void | Promise<void>;
  /** Injectable for tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Default: Math.random. */
  random?: () => number;
  /** Injectable for tests. Default: Date.now. */
  now?: () => number;
}

export interface ModelChainSuccess<T> {
  ok: true;
  value: T;
  model: string;
  attempts: AiAttemptRecord[];
  fellBack: boolean;
}

export interface ModelChainFailure {
  ok: false;
  attempts: AiAttemptRecord[];
  failure: AiFailure;
}

const DEFAULT_MAX_RETRIES_PER_MODEL = 1;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, capped at 8000ms. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  const jittered = Math.floor(base * random());
  return Math.min(8000, Math.max(0, jittered));
}

const STATUS_BY_KIND: Record<AiFailure["kind"], AiAttemptRecord["status"]> = {
  TRANSIENT: "TRANSIENT_ERROR",
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  AUTH: "AUTH_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  UNKNOWN: "UNKNOWN_ERROR",
};

async function notify<T>(
  onAttempt: RunModelChainOptions<T>["onAttempt"],
  record: AiAttemptRecord,
): Promise<void> {
  if (!onAttempt) return;
  try {
    await onAttempt(record);
  } catch (error) {
    logger.warn("ai_model_chain.on_attempt_failed", {
      model: record.model,
      status: record.status,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

export async function runModelChain<T>(
  o: RunModelChainOptions<T>,
): Promise<ModelChainSuccess<T> | ModelChainFailure> {
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
  const now = o.now ?? Date.now;
  const maxRetriesPerModel = o.maxRetriesPerModel ?? DEFAULT_MAX_RETRIES_PER_MODEL;

  const attempts: AiAttemptRecord[] = [];
  let lastFailure: AiFailure = { kind: "SCHEMA_INVALID", code: "schema_invalid" };

  for (const [modelIndex, model] of o.models.entries()) {
    let transientRetriesUsed = 0;
    let correctiveRetryUsed = 0;
    let attemptNumber = 0;

    for (;;) {
      attemptNumber += 1;
      const controller = new AbortController();
      const requestTimeoutMs =
        modelIndex === 0 ? o.timeoutMs : (o.fallbackTimeoutMs ?? o.timeoutMs);
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const startedAt = now();

      let outcome:
        | { type: "success"; value: T }
        | { type: "invalid"; message: string }
        | { type: "error"; failure: AiFailure };

      try {
        const raw = await o.call(model, controller.signal);
        const validated = o.validate(raw);
        outcome = validated.ok
          ? { type: "success", value: validated.value }
          : { type: "invalid", message: validated.message };
      } catch (error) {
        outcome = { type: "error", failure: classifyAiError(error) };
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = now() - startedAt;

      if (outcome.type === "success") {
        const record: AiAttemptRecord = {
          model,
          attempt: attemptNumber,
          status: "SUCCESS",
          latencyMs,
        };
        attempts.push(record);
        await notify(o.onAttempt, record);
        return {
          ok: true,
          value: outcome.value,
          model,
          attempts,
          fellBack: model !== o.models[0],
        };
      }

      if (outcome.type === "invalid") {
        const record: AiAttemptRecord = {
          model,
          attempt: attemptNumber,
          status: "SCHEMA_INVALID",
          errorCode: "schema_invalid",
          latencyMs,
        };
        attempts.push(record);
        await notify(o.onAttempt, record);
        lastFailure = { kind: "SCHEMA_INVALID", code: "schema_invalid" };

        if (correctiveRetryUsed === 0) {
          correctiveRetryUsed = 1;
          continue; // retry same model
        }
        break; // move to next model
      }

      // outcome.type === "error"
      const failure = outcome.failure;
      lastFailure = failure;
      const record: AiAttemptRecord = {
        model,
        attempt: attemptNumber,
        status: STATUS_BY_KIND[failure.kind],
        errorCode: failure.code,
        latencyMs,
      };
      attempts.push(record);
      await notify(o.onAttempt, record);

      if (failure.kind === "AUTH" || failure.kind === "INVALID_REQUEST") {
        return { ok: false, attempts, failure };
      }

      if (failure.kind === "QUOTA_EXHAUSTED") {
        break; // move to next model, no retry, no sleep
      }

      // A request timeout has already consumed the full latency budget for
      // this model. Retrying it immediately doubles the wait without evidence
      // that the next attempt will finish; fall through to the faster model.
      if (failure.kind === "TIMEOUT") {
        break;
      }

      if (failure.kind === "RATE_LIMITED") {
        if (transientRetriesUsed < maxRetriesPerModel) {
          transientRetriesUsed += 1;
          const delayMs =
            failure.retryAfterSeconds !== undefined
              ? Math.min(30000, failure.retryAfterSeconds * 1000)
              : backoffDelayMs(transientRetriesUsed, random);
          await sleep(delayMs);
          continue; // retry same model
        }
        break; // move to next model
      }

      // TRANSIENT and UNKNOWN failures retain bounded same-model retries.
      if (transientRetriesUsed < maxRetriesPerModel) {
        transientRetriesUsed += 1;
        await sleep(backoffDelayMs(transientRetriesUsed, random));
        continue; // retry same model
      }
      break; // move to next model
    }
  }

  return { ok: false, attempts, failure: lastFailure };
}
