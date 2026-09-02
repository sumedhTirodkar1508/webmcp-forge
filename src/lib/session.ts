import "server-only";

import { cookies } from "next/headers";

import type { BuilderSession, Site } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { generateToken, hashToken, isPlausibleToken } from "@/lib/tokens";

/**
 * Anonymous builder ownership.
 *
 * There is no sign-up in the MVP. Instead the first operation that needs an
 * owner mints a 256-bit random bearer token, hands the RAW token to the browser
 * in an HttpOnly cookie, and stores only its SHA-256 digest. The browser can
 * never read the token from JavaScript, and a database dump yields nothing
 * replayable.
 *
 * A future Auth.js migration can claim these rows by setting `Site.ownerUserId`;
 * nothing here needs to change for that.
 */

export const SESSION_COOKIE = "wmf_session";

/** 30 days. Long enough that a contest demo survives a weekend. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Refresh `lastSeenAt`/`expiresAt` at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // `lax` rather than `strict`: the verification flow returns the user to the
    // builder from a different tab, and `strict` would drop the cookie on that
    // top-level navigation.
    sameSite: "lax" as const,
    // Off on plain-http localhost, on everywhere else.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Returns the current session without creating one. Safe to call from a Server
 * Component, where cookies cannot be written.
 */
export async function getBuilderSession(): Promise<BuilderSession | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isPlausibleToken(raw)) return null;

  const session = await prisma.builderSession.findUnique({
    where: { tokenHash: hashToken(raw) },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  return session;
}

/**
 * Returns the current session, creating one if needed.
 *
 * Only callable from a Server Function or Route Handler: it may need to write a
 * `Set-Cookie` header, which Server Component rendering cannot do.
 */
export async function requireBuilderSession(): Promise<BuilderSession> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const now = Date.now();

  if (isPlausibleToken(raw)) {
    const existing = await prisma.builderSession.findUnique({
      where: { tokenHash: hashToken(raw) },
    });

    if (existing && existing.expiresAt.getTime() > now) {
      // Sliding expiry, written sparingly.
      if (now - existing.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        const refreshed = await prisma.builderSession.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: new Date(now),
            expiresAt: new Date(now + SESSION_TTL_MS),
          },
        });
        jar.set(SESSION_COOKIE, raw, cookieOptions(SESSION_TTL_MS / 1000));
        return refreshed;
      }
      return existing;
    }
  }

  const token = generateToken();
  const session = await prisma.builderSession.create({
    data: {
      tokenHash: hashToken(token),
      expiresAt: new Date(now + SESSION_TTL_MS),
    },
  });

  jar.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS / 1000));
  return session;
}

/**
 * Loads a site the caller is allowed to touch.
 *
 * Never trust a site id from the browser: ownership is re-checked here on every
 * private operation. Missing and forbidden collapse to the same 404-ish error
 * so a stranger cannot probe which site ids exist.
 */
export async function requireOwnedSite(siteId: string): Promise<Site> {
  const session = await getBuilderSession();
  if (!session) {
    throw new AppError("UNAUTHORIZED", "Your builder session has expired. Reload the page to start again.");
  }
  return requireOwnedSiteFor(session, siteId);
}

export async function requireOwnedSiteFor(
  session: BuilderSession,
  siteId: string,
): Promise<Site> {
  const site = await prisma.site.findUnique({ where: { id: siteId } });

  if (!site || site.createdBySessionId !== session.id) {
    throw new AppError("NOT_FOUND", "That site could not be found.");
  }
  return site;
}

/** The caller's sites, newest first. */
export async function listOwnedSites(session: BuilderSession): Promise<Site[]> {
  return prisma.site.findMany({
    where: { createdBySessionId: session.id },
    orderBy: { createdAt: "desc" },
  });
}
