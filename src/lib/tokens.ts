import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token helpers shared by anonymous builder sessions and installation
 * verification challenges.
 *
 * Both follow the same rule: the raw token exists only in transit (an HttpOnly
 * cookie, or a one-shot URL parameter), and the database stores nothing but a
 * SHA-256 digest. A dump of the database therefore yields nothing replayable.
 *
 * A plain unsalted digest is sufficient here — unlike a password, the token is
 * 256 bits of uniform randomness, so there is no dictionary to run and no
 * meaningful preimage advantage from precomputation.
 */

const TOKEN_BYTES = 32; // 256 bits

/** URL-safe base64 of 256 cryptographically random bits. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** The value stored server-side. Never store the raw token. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Cheap shape gate so absurd input never reaches the database. */
export function isPlausibleToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
