import { randomBytes, randomUUID } from "node:crypto";

/**
 * Crockford-style base32 without the ambiguous letters I, L, O and U. Keeps
 * public identifiers readable when a user copies one out of a script tag.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PUBLIC_ID_LENGTH = 24;
const PUBLIC_ID_PREFIX = "wmf_";

/** Uniformly samples `length` characters from ALPHABET, rejecting bias. */
function randomBase32(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      // 256 is not a multiple of 32, but 32 divides 256 exactly (8 groups),
      // so masking the low 5 bits is unbiased.
      out += ALPHABET[byte & 31];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * A site's public runtime identifier. Not a secret — it ships inside the
 * installation snippet — but 24 base32 characters (120 bits) make the space far
 * too large to enumerate.
 */
export function generatePublicSiteId(): string {
  return PUBLIC_ID_PREFIX + randomBase32(PUBLIC_ID_LENGTH);
}

const PUBLIC_ID_RE = new RegExp(
  `^${PUBLIC_ID_PREFIX}[${ALPHABET}]{${PUBLIC_ID_LENGTH}}$`,
);

/** Shape check for a value arriving from an untrusted request. */
export function isValidPublicSiteId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_ID_RE.test(value);
}

export { randomUUID };
