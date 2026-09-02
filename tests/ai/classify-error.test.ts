import { describe, expect, it } from "vitest";
import { classifyAiError, parseRetryAfter } from "@/lib/ai/classify-error";

describe("classifyAiError", () => {
  it("classifies AbortError by name as TIMEOUT", () => {
    const error = Object.assign(new Error("aborted"), { name: "AbortError" });
    const result = classifyAiError(error);
    expect(result.kind).toBe("TIMEOUT");
    expect(result.code).toBe("timeout");
  });

  it("classifies TimeoutError by name as TIMEOUT", () => {
    const error = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(classifyAiError(error).kind).toBe("TIMEOUT");
  });

  it("extracts status from error.status", () => {
    const error = { status: 400, message: "bad" };
    expect(classifyAiError(error).kind).toBe("INVALID_REQUEST");
  });

  it("extracts status from error.statusCode", () => {
    const error = { statusCode: 500, message: "boom" };
    expect(classifyAiError(error).kind).toBe("TRANSIENT");
  });

  it("extracts status from numeric error.code", () => {
    const error = { code: 401, message: "nope" };
    expect(classifyAiError(error).kind).toBe("AUTH");
  });

  it("extracts status from error.response.status", () => {
    const error = { response: { status: 403 }, message: "nope" };
    expect(classifyAiError(error).kind).toBe("AUTH");
  });

  it("extracts a status from a message pattern when no field is present", () => {
    const error = new Error("Request failed with status 503");
    expect(classifyAiError(error).kind).toBe("TRANSIENT");
  });

  it("maps 400 to INVALID_REQUEST", () => {
    expect(classifyAiError({ status: 400 }).kind).toBe("INVALID_REQUEST");
  });

  it("maps 401 to AUTH", () => {
    expect(classifyAiError({ status: 401 }).kind).toBe("AUTH");
  });

  it("maps 403 to AUTH", () => {
    expect(classifyAiError({ status: 403 }).kind).toBe("AUTH");
  });

  it("maps 404 to INVALID_REQUEST", () => {
    expect(classifyAiError({ status: 404 }).kind).toBe("INVALID_REQUEST");
  });

  it("maps 408 to TIMEOUT", () => {
    expect(classifyAiError({ status: 408 }).kind).toBe("TIMEOUT");
  });

  it("maps 5xx to TRANSIENT", () => {
    expect(classifyAiError({ status: 500 }).kind).toBe("TRANSIENT");
    expect(classifyAiError({ status: 502 }).kind).toBe("TRANSIENT");
    expect(classifyAiError({ status: 503 }).kind).toBe("TRANSIENT");
    expect(classifyAiError({ status: 500 }).code).toBe("http_500");
  });

  it("classifies 429 with quota wording as QUOTA_EXHAUSTED", () => {
    const error = { status: 429, message: "You exceeded your current quota, please check your billing" };
    const result = classifyAiError(error);
    expect(result.kind).toBe("QUOTA_EXHAUSTED");
    expect(result.code).toBe("quota_exhausted");
  });

  it("classifies 429 with RESOURCE_EXHAUSTED and no retry hint as QUOTA_EXHAUSTED", () => {
    const error = { status: 429, message: "RESOURCE_EXHAUSTED: too many requests" };
    expect(classifyAiError(error).kind).toBe("QUOTA_EXHAUSTED");
  });

  it("classifies 429 with a retry hint as RATE_LIMITED even if it mentions RESOURCE_EXHAUSTED", () => {
    const error = {
      status: 429,
      message: "RESOURCE_EXHAUSTED: per-minute limit",
      retryDelay: 2,
    };
    const result = classifyAiError(error);
    expect(result.kind).toBe("RATE_LIMITED");
    expect(result.retryAfterSeconds).toBe(2);
  });

  it("classifies a plain 429 per-minute throttle as RATE_LIMITED", () => {
    const error = { status: 429, message: "Too many requests, please slow down" };
    expect(classifyAiError(error).kind).toBe("RATE_LIMITED");
  });

  it("detects network errors from message substrings", () => {
    const patterns = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "fetch failed",
      "socket hang up",
      "network error",
    ];
    for (const pattern of patterns) {
      const result = classifyAiError(new Error(`Something happened: ${pattern}`));
      expect(result.kind).toBe("TRANSIENT");
      expect(result.code.startsWith("network_")).toBe(true);
    }
  });

  it("falls back to UNKNOWN for unrecognized errors", () => {
    const result = classifyAiError(new Error("something completely unexpected"));
    expect(result.kind).toBe("UNKNOWN");
    expect(result.code).toBe("unknown");
  });

  it("falls back to UNKNOWN for non-object, non-error values", () => {
    expect(classifyAiError("just a string").kind).toBe("UNKNOWN");
    expect(classifyAiError(null).kind).toBe("UNKNOWN");
    expect(classifyAiError(undefined).kind).toBe("UNKNOWN");
  });

  it("never includes the raw message in the code", () => {
    const secretMessage = "leaked-api-key-abc123 super secret detail";
    const result = classifyAiError(new Error(secretMessage));
    expect(result.code).not.toContain("leaked-api-key-abc123");
    expect(result.code).toMatch(/^[a-z0-9_]+$/);
  });

  it("caps code length at 60 chars and only uses [a-z0-9_]", () => {
    const error = { status: 500 };
    const result = classifyAiError(error);
    expect(result.code.length).toBeLessThanOrEqual(60);
    expect(result.code).toMatch(/^[a-z0-9_]+$/);
  });

  it("reads retryDelay/retry_after/Retry-After off the error object", () => {
    expect(classifyAiError({ status: 429, retryDelay: 5 }).retryAfterSeconds).toBe(5);
    expect(classifyAiError({ status: 429, retry_after: "7" }).retryAfterSeconds).toBe(7);
    expect(classifyAiError({ status: 429, "Retry-After": "3" }).retryAfterSeconds).toBe(3);
  });

  it("reads Retry-After from response.headers as a plain object", () => {
    const error = { status: 429, response: { status: 429, headers: { "Retry-After": "4" } } };
    expect(classifyAiError(error).retryAfterSeconds).toBe(4);
  });

  it("reads Retry-After from response.headers as a Headers instance", () => {
    const headers = new Headers({ "Retry-After": "6" });
    const error = { status: 429, response: { status: 429, headers } };
    expect(classifyAiError(error).retryAfterSeconds).toBe(6);
  });
});

describe("parseRetryAfter", () => {
  it("accepts a plain number of seconds", () => {
    expect(parseRetryAfter(5)).toBe(5);
  });

  it("accepts a numeric string", () => {
    expect(parseRetryAfter("12")).toBe(12);
  });

  it("accepts an HTTP-date string", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(future);
    expect(result).toBeGreaterThanOrEqual(8);
    expect(result).toBeLessThanOrEqual(12);
  });

  it("returns undefined for garbage input", () => {
    expect(parseRetryAfter("not-a-date-or-number")).toBeUndefined();
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("clamps to 0..120", () => {
    expect(parseRetryAfter(9999)).toBe(120);
    expect(parseRetryAfter(-50)).toBe(0);
  });

  it("returns whole seconds", () => {
    expect(parseRetryAfter(2.7)).toBe(3);
  });
});

describe("parseRetryAfter — protobuf durations", () => {
  // Gemini's RetryInfo carries a duration string, not the bare seconds an HTTP
  // Retry-After header uses. Without this, a real 429 would fall back to
  // exponential backoff and ignore what the provider actually asked for.
  it("parses second, minute and millisecond durations", () => {
    expect(parseRetryAfter("34s")).toBe(34);
    expect(parseRetryAfter("2S")).toBe(2);
    expect(parseRetryAfter("1.5s")).toBe(2);
    expect(parseRetryAfter("500ms")).toBe(1);
    expect(parseRetryAfter("100ms")).toBe(0);
    expect(parseRetryAfter("1m")).toBe(60);
  });

  it("still clamps a hostile duration to the 120s ceiling", () => {
    expect(parseRetryAfter("9999s")).toBe(120);
    expect(parseRetryAfter("60m")).toBe(120);
  });

  it("ignores durations it cannot understand", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("10 seconds")).toBeUndefined();
    expect(parseRetryAfter("s")).toBeUndefined();
  });
});
