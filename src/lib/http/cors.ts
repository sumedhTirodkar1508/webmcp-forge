import "server-only";

/**
 * Narrow CORS for the two public endpoints.
 *
 * An installed portfolio lives on a different origin from WebMCP Forge, so it
 * genuinely needs cross-origin access — but only for its own site. Rather than
 * `*`, each response echoes the one origin that site was published for, and
 * `Vary: Origin` keeps a CDN from serving one site's header to another.
 *
 * Credentials are never allowed: the runtime fetches with `credentials: "omit"`,
 * so no cookie or session is ever in play across this boundary.
 */

export interface CorsDecision {
  allowed: boolean;
  headers: Record<string, string>;
}

export function corsFor(
  requestOrigin: string | null,
  expectedOrigin: string,
  methods: string,
): CorsDecision {
  const base: Record<string, string> = {
    vary: "Origin",
    "access-control-allow-methods": methods,
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
  };

  // A same-origin or origin-less request (e.g. a direct navigation) needs no
  // allow header at all and is not blocked by CORS in the first place.
  if (!requestOrigin) return { allowed: true, headers: base };

  if (requestOrigin === expectedOrigin) {
    return {
      allowed: true,
      headers: { ...base, "access-control-allow-origin": expectedOrigin },
    };
  }

  return { allowed: false, headers: base };
}
