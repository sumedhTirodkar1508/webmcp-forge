/**
 * Application error taxonomy.
 *
 * Every failure a user can trigger gets a stable machine code and a message
 * that is safe to render. Anything unexpected collapses to INTERNAL, so raw
 * exception text and stack traces never leave the server.
 */

export const ERROR_CODES = [
  "INVALID_URL",
  "BLOCKED_TARGET",
  "FETCH_TIMEOUT",
  "FETCH_FAILED",
  "NOT_HTML",
  "TOO_LARGE",
  "TOO_MANY_REDIRECTS",
  "SCAN_PARTIAL",
  "SCAN_FAILED",
  "LOW_INFORMATION",
  "AI_UNAVAILABLE",
  "AI_INVALID_OUTPUT",
  "AI_QUOTA",
  "RATE_LIMITED",
  "NOT_FOUND",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "CONFLICT",
  "VALIDATION_FAILED",
  "NO_PUBLISHED_CONFIG",
  "VERIFICATION_EXPIRED",
  "VERIFICATION_CONSUMED",
  "VERIFICATION_ORIGIN_MISMATCH",
  "VERIFICATION_SITE_MISMATCH",
  "VERIFICATION_TIMEOUT",
  "DEMO_LIMIT_REACHED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_TARGET: 400,
  FETCH_TIMEOUT: 504,
  FETCH_FAILED: 502,
  NOT_HTML: 415,
  TOO_LARGE: 413,
  TOO_MANY_REDIRECTS: 502,
  SCAN_PARTIAL: 200,
  SCAN_FAILED: 502,
  LOW_INFORMATION: 200,
  AI_UNAVAILABLE: 503,
  AI_INVALID_OUTPUT: 502,
  AI_QUOTA: 429,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  VALIDATION_FAILED: 400,
  NO_PUBLISHED_CONFIG: 404,
  VERIFICATION_EXPIRED: 410,
  VERIFICATION_CONSUMED: 409,
  VERIFICATION_ORIGIN_MISMATCH: 403,
  VERIFICATION_SITE_MISMATCH: 403,
  VERIFICATION_TIMEOUT: 408,
  DEMO_LIMIT_REACHED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Extra structured context safe to send to the client. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Converts anything thrown into a user-safe AppError. Unknown failures keep
 * their detail server-side only.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  return new AppError(
    "INTERNAL",
    "Something went wrong on our side. Please try again.",
  );
}
