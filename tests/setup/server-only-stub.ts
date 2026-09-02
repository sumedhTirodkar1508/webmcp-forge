/**
 * Stands in for the `server-only` package under Vitest.
 *
 * The real package throws on import outside a Server Component. That guard is
 * a build-time check enforced by the Next.js compiler, which is where it
 * matters; a Node test runner has no server/client boundary for it to protect.
 */
export {};
