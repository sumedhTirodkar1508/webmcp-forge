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
  "HOST_NOT_FOUND",
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
  "DATABASE_UNAVAILABLE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_TARGET: 400,
  HOST_NOT_FOUND: 400,
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
  DATABASE_UNAVAILABLE: 503,
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

export const DATABASE_UNAVAILABLE_MESSAGE =
  "We're having trouble reaching our database. It may be waking up after a quiet spell — please try again in a few seconds.";

/** Prisma error codes that mean "could not talk to the database at all". */
const UNREACHABLE_PRISMA_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1017", // server closed the connection
  "P2024", // timed out waiting for a pooled connection
]);

/**
 * Network and server-state failures, matched on the message because driver
 * adapters wrap them in several different error classes. Deliberately
 * specific: a query bug must still surface as INTERNAL, not be disguised as an
 * outage.
 */
const UNREACHABLE_MESSAGE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|Connection terminated|timeout exceeded when trying to connect|Can't reach database server|tenant\/user \S+ not found|too many (?:clients|connections)|the database system is (?:starting up|shutting down|in recovery mode)|terminating connection due to administrator command|Control plane request failed|endpoint is disabled/i;

/**
 * True when an error means the database could not be reached, as opposed to a
 * query that ran and failed. Follows `cause` a few levels, since adapters wrap.
 */
export function isDatabaseUnavailable(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  const error = value as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

  if (error.name === "PrismaClientInitializationError") return true;
  if (typeof error.code === "string" && UNREACHABLE_PRISMA_CODES.has(error.code)) return true;
  if (typeof error.message === "string" && UNREACHABLE_MESSAGE.test(error.message)) return true;

  return isDatabaseUnavailable(error.cause, depth + 1);
}

/**
 * A one-line, log-safe summary of a database failure.
 *
 * Prisma puts a long "Invalid `prisma.x()` invocation in <bundle path>"
 * preamble first and the actual cause (e.g. "connect ECONNREFUSED …") last, so
 * keeping the start of the message — as logs did — kept nothing useful.
 */
export function summarizeDatabaseError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  const code =
    value && typeof value === "object" && typeof (value as { code?: unknown }).code === "string"
      ? `${(value as { code: string }).code}: `
      : "";
  return `${code}${lines.at(-1) ?? ""}`.slice(0, 300);
}

/**
 * Converts anything thrown into a user-safe AppError. Unknown failures keep
 * their detail server-side only.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  // A cold or briefly unreachable database is worth saying plainly: the
  // person can simply retry, which "something went wrong" doesn't tell them.
  if (isDatabaseUnavailable(value)) {
    return new AppError("DATABASE_UNAVAILABLE", DATABASE_UNAVAILABLE_MESSAGE);
  }
  return new AppError(
    "INTERNAL",
    "Something went wrong on our side. Please try again.",
  );
}
