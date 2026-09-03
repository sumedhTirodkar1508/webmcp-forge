import { z } from "zod";

import { toAppError } from "@/lib/errors";
import { corsFor } from "@/lib/http/cors";
import { isValidPublicSiteId } from "@/lib/ids";
import { prisma } from "@/lib/prisma";
import {
  claimNextCommand,
  completeCommand,
  markReady,
  MAX_ERROR_CHARS,
  MAX_RESULT_CHARS,
} from "@/lib/services/live-test-service";
import { isPlausibleToken } from "@/lib/tokens";

/**
 * The live agent test relay endpoint.
 *
 * POST /api/public/live-test
 *
 * Spoken to cross-origin by the installed runtime, but ONLY while the owner has
 * explicitly started a test and the page was opened with a live-test token. The
 * ordinary runtime never calls this.
 *
 * As with verification, the browser-asserted `Origin` header is load-bearing:
 * page script cannot forge it, so matching it against the origin the session
 * was opened for proves the traffic came from the real portfolio. The token
 * alone is not sufficient.
 */

const METHODS = "POST, OPTIONS";

const baseSchema = z.object({
  siteId: z.string().max(64).refine(isValidPublicSiteId, "invalid site id"),
  token: z.string().max(256).refine(isPlausibleToken, "invalid token"),
});

const readySchema = baseSchema.extend({
  action: z.literal("ready"),
  runtimeVersion: z.string().max(32),
  availableTools: z.array(z.string().max(64)).max(50).default([]),
});

const pollSchema = baseSchema.extend({ action: z.literal("poll") });

const resultSchema = baseSchema.extend({
  action: z.literal("result"),
  commandId: z.uuid(),
  result: z.string().max(MAX_RESULT_CHARS).optional(),
  errorCode: z.string().max(MAX_ERROR_CHARS).optional(),
});

const bodySchema = z.discriminatedUnion("action", [readySchema, pollSchema, resultSchema]);

async function expectedOriginFor(publicId: string): Promise<string | null> {
  if (!isValidPublicSiteId(publicId)) return null;
  const site = await prisma.site.findUnique({
    where: { publicId },
    select: { origin: true },
  });
  return site?.origin ?? null;
}

export async function OPTIONS(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return new Response(null, { status: 204 });

  const known = await prisma.site.findFirst({
    where: { origin: requestOrigin },
    select: { origin: true },
  });
  if (!known) return new Response(null, { status: 403, headers: { vary: "Origin" } });

  return new Response(null, {
    status: 204,
    headers: corsFor(requestOrigin, known.origin, METHODS).headers,
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");

  const raw = await request.text();
  if (raw.length > 32 * 1024) {
    return Response.json(
      { error: { code: "VALIDATION_FAILED", message: "That request was too large." } },
      { status: 400, headers: { vary: "Origin" } },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(JSON.parse(raw || "{}"));
  } catch {
    return Response.json(
      { error: { code: "VALIDATION_FAILED", message: "That request could not be understood." } },
      { status: 400, headers: { vary: "Origin" } },
    );
  }

  const expectedOrigin = await expectedOriginFor(body.siteId);
  const cors = corsFor(requestOrigin, expectedOrigin ?? "", METHODS);

  if (!expectedOrigin || !cors.allowed) {
    return Response.json(
      {
        error: {
          code: "VERIFICATION_ORIGIN_MISMATCH",
          message: "That request did not come from the website we expected.",
        },
      },
      { status: 403, headers: cors.headers },
    );
  }

  const headers = { ...cors.headers, "cache-control": "no-store" };

  try {
    if (body.action === "ready") {
      const { expiresAt } = await markReady(body.token, body.siteId, requestOrigin, {
        runtimeVersion: body.runtimeVersion,
        availableTools: body.availableTools,
      });
      return Response.json({ ok: true, expiresAt: expiresAt.toISOString() }, { headers });
    }

    if (body.action === "poll") {
      const command = await claimNextCommand(body.token, body.siteId, requestOrigin);
      return Response.json({ ok: true, command }, { headers });
    }

    const { accepted } = await completeCommand(body.token, body.siteId, requestOrigin, {
      commandId: body.commandId,
      result: body.result,
      errorCode: body.errorCode,
    });
    return Response.json({ ok: true, accepted }, { headers });
  } catch (error) {
    const appError = toAppError(error);
    return Response.json(appError.toJSON(), { status: appError.status, headers });
  }
}
