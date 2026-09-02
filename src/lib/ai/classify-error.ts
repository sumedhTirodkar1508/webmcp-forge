/**
 * Classifies opaque failures from the Gemini SDK (or the transport beneath
 * it) into a small taxonomy the model-fallback executor can act on.
 *
 * Deliberately conservative: we never forward the raw error message or body
 * anywhere it might be persisted or logged. `code` is a short sanitized slug
 * safe for a database column.
 */

export type AiFailureKind =
  | "TRANSIENT" // network blip, 5xx, socket hangup
  | "TIMEOUT"
  | "RATE_LIMITED" // short-term 429, retry the SAME model
  | "QUOTA_EXHAUSTED" // model/project quota gone, move to the NEXT model
  | "AUTH" // 401/403 — stop entirely
  | "INVALID_REQUEST" // 400 — stop entirely
  | "SCHEMA_INVALID" // parsed but failed our Zod validation
  | "UNKNOWN";

export interface AiFailure {
  kind: AiFailureKind;
  /** Short, non-sensitive classification string for the DB. Never the raw provider body. */
  code: string;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfterSeconds?: number;
}

const NETWORK_PATTERNS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "enotfound",
  "fetch failed",
  "socket hang up",
  "network",
];

const QUOTA_PATTERNS = [
  "quota",
  "exhausted",
  "exceeded your current quota",
  "billing",
  "insufficient",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Sanitizes free text into a stable `[a-z0-9_]` slug capped at 60 chars. */
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 60) || "unknown";
}

function errorName(error: unknown): string {
  if (isRecord(error) && typeof error.name === "string") return error.name;
  return "";
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  return "";
}

function numericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    const match = errorMessage(error).match(/\b([45]\d\d)\b/);
    return match ? Number(match[1]) : undefined;
  }

  const direct = numericStatus(error.status);
  if (direct !== undefined) return direct;

  const statusCode = numericStatus(error.statusCode);
  if (statusCode !== undefined) return statusCode;

  const code = numericStatus(error.code);
  if (code !== undefined) return code;

  if (isRecord(error.response)) {
    const responseStatus = numericStatus(error.response.status);
    if (responseStatus !== undefined) return responseStatus;
  }

  const match = errorMessage(error).match(/\b([45]\d\d)\b/);
  return match ? Number(match[1]) : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Accepts a number (seconds), a numeric string (seconds), or an HTTP-date
 * string, and returns whole seconds clamped to 0..120. Anything else
 * (including negative or unparseable values) yields undefined.
 */
export function parseRetryAfter(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  let seconds: number | undefined;

  if (typeof value === "number") {
    seconds = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      seconds = Number(trimmed);
    } else if (/^\d+(\.\d+)?(ms|s|m)$/i.test(trimmed)) {
      // Google's RetryInfo sends a protobuf duration such as "34s" or "500ms",
      // not the bare seconds an HTTP Retry-After header carries.
      const amount = Number.parseFloat(trimmed);
      const unit = trimmed.replace(/^[\d.]+/, "").toLowerCase();
      seconds = unit === "ms" ? amount / 1000 : unit === "m" ? amount * 60 : amount;
    } else {
      const parsedDate = Date.parse(trimmed);
      if (!Number.isNaN(parsedDate)) {
        seconds = (parsedDate - Date.now()) / 1000;
      }
    }
  }

  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const whole = Math.round(seconds);
  return Math.min(120, Math.max(0, whole));
}

function findRetryAfterSeconds(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;

  const direct =
    parseRetryAfter(error.retryDelay) ??
    parseRetryAfter(error.retry_after) ??
    parseRetryAfter((error as Record<string, unknown>)["Retry-After"]);
  if (direct !== undefined) return direct;

  if (isRecord(error.response)) {
    const headers = error.response.headers;
    const fromHeaders =
      parseRetryAfter(headerValue(headers, "Retry-After")) ??
      parseRetryAfter(headerValue(headers, "retry-after"));
    if (fromHeaders !== undefined) return fromHeaders;
  }

  return undefined;
}

export function classifyAiError(error: unknown): AiFailure {
  const name = errorName(error);
  const message = errorMessage(error);
  const lowerMessage = message.toLowerCase();
  const retryAfterSeconds = findRetryAfterSeconds(error);

  if (name === "AbortError" || name === "TimeoutError") {
    return { kind: "TIMEOUT", code: "timeout", retryAfterSeconds };
  }

  const status = extractStatus(error);

  if (status !== undefined) {
    if (status === 400) {
      return { kind: "INVALID_REQUEST", code: "http_400", retryAfterSeconds };
    }
    if (status === 401 || status === 403) {
      return { kind: "AUTH", code: `http_${status}`, retryAfterSeconds };
    }
    if (status === 404) {
      return { kind: "INVALID_REQUEST", code: "http_404", retryAfterSeconds };
    }
    if (status === 408) {
      return { kind: "TIMEOUT", code: "http_408", retryAfterSeconds };
    }
    if (status === 429) {
      const hasResourceExhaustedStatus = lowerMessage.includes("resource_exhausted");
      // "exhausted" alone is a generic quota keyword, but when it only shows up
      // as part of the RESOURCE_EXHAUSTED gRPC status string we defer to the
      // dedicated check below, which looks at whether the provider also gave
      // us a retry hint (a short per-minute throttle) before calling it quota.
      const hasGenericQuotaKeyword = QUOTA_PATTERNS.some(
        (p) => lowerMessage.includes(p) && !(p === "exhausted" && hasResourceExhaustedStatus),
      );
      const looksLikeQuota =
        hasGenericQuotaKeyword ||
        (hasResourceExhaustedStatus && retryAfterSeconds === undefined);
      if (looksLikeQuota) {
        return { kind: "QUOTA_EXHAUSTED", code: "quota_exhausted", retryAfterSeconds };
      }
      return { kind: "RATE_LIMITED", code: "http_429", retryAfterSeconds };
    }
    if (status >= 500 && status < 600) {
      return { kind: "TRANSIENT", code: `http_${status}`, retryAfterSeconds };
    }
  }

  for (const pattern of NETWORK_PATTERNS) {
    if (lowerMessage.includes(pattern)) {
      return { kind: "TRANSIENT", code: `network_${slug(pattern)}`, retryAfterSeconds };
    }
  }

  return { kind: "UNKNOWN", code: "unknown", retryAfterSeconds };
}
