import { z } from "zod";

import { toAppError } from "@/lib/errors";
import { corsFor } from "@/lib/http/cors";
import { isValidPublicSiteId } from "@/lib/ids";
import { prisma } from "@/lib/prisma";
import { isPlausibleToken } from "@/lib/tokens";
import { recordVerification } from "@/lib/services/verification-service";

/**
 * The installation-verification callback.
 *
 * POST /api/public/verify
 *
 * Called cross-origin by the runtime running on the owner's actual portfolio.
 * The `Origin` header is the load-bearing part: the browser sets it and page
 * script cannot forge it, so matching it against the origin the challenge was
 * issued for is what proves the report came from the real site rather than from
 * someone replaying a payload.
 *
 * The challenge itself is single-use and short-lived, and only its hash is
 * stored — see `verification-service.ts`.
 */

const METHODS = "POST, OPTIONS";

const reportSchema = z.object({
  siteId: z.string().max(64).refine(isValidPublicSiteId, "invalid site id"),
  challenge: z.string().max(256).refine(isPlausibleToken, "invalid challenge"),
  runtimeVersion: z.string().max(32),
  configVersion: z.number().int().min(0).max(1_000_000),
  path: z.string().max(500),
  webmcpAvailable: z.boolean(),
  webmcpReason: z.string().max(64).nullable().default(null),
  toolsRegistered: z.number().int().min(0).max(100),
  toolNames: z.array(z.string().max(64)).max(50).default([]),
  toolsVisibleToBrowser: z.array(z.string().max(64)).max(50).default([]),
  toolRegistrationFailures: z
    .array(z.object({ name: z.string().max(64), message: z.string().max(300) }))
    .max(50)
    .default([]),
  existingTools: z.array(z.string().max(64)).max(50).default([]),
  conflictingTools: z.array(z.string().max(64)).max(50).default([]),
  liveCounts: z.record(z.string().max(40), z.number().int().min(0).max(100_000)).default({}),
  mappingHealth: z.record(z.string().max(40), z.boolean()).default({}),
});

/** Resolves the origin a site was published for, without leaking existence. */
async function expectedOriginFor(publicId: string): Promise<string | null> {
  if (!isValidPublicSiteId(publicId)) return null;
  const site = await prisma.site.findUnique({
    where: { publicId },
    select: { origin: true },
  });
  return site?.origin ?? null;
}

export async function OPTIONS(request: Request): Promise<Response> {
  // The preflight carries no body, so the site id comes from the origin itself.
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return new Response(null, { status: 204 });

  const known = await prisma.site.findFirst({
    where: { origin: requestOrigin },
    select: { origin: true },
  });
  if (!known) return new Response(null, { status: 403, headers: { vary: "Origin" } });

  const cors = corsFor(requestOrigin, known.origin, METHODS);
  return new Response(null, { status: 204, headers: cors.headers });
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");

  const raw = await request.text();
  if (raw.length > 32 * 1024) {
    return Response.json(
      { error: { code: "VALIDATION_FAILED", message: "That report was too large." } },
      { status: 400, headers: { vary: "Origin" } },
    );
  }

  let parsed: z.infer<typeof reportSchema>;
  try {
    parsed = reportSchema.parse(JSON.parse(raw || "{}"));
  } catch {
    return Response.json(
      { error: { code: "VALIDATION_FAILED", message: "That report could not be understood." } },
      { status: 400, headers: { vary: "Origin" } },
    );
  }

  const expectedOrigin = await expectedOriginFor(parsed.siteId);
  const cors = corsFor(requestOrigin, expectedOrigin ?? "", METHODS);

  if (!expectedOrigin || !cors.allowed) {
    return Response.json(
      {
        error: {
          code: "VERIFICATION_ORIGIN_MISMATCH",
          message: "That report did not come from the website we expected.",
        },
      },
      { status: 403, headers: cors.headers },
    );
  }

  try {
    const run = await recordVerification(parsed, requestOrigin);
    return Response.json(
      { ok: true, outcome: run.outcome },
      { headers: { ...cors.headers, "cache-control": "no-store" } },
    );
  } catch (error) {
    const appError = toAppError(error);
    return Response.json(appError.toJSON(), {
      status: appError.status,
      headers: { ...cors.headers, "cache-control": "no-store" },
    });
  }
}
