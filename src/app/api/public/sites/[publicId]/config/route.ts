import { corsFor } from "@/lib/http/cors";
import { isValidPublicSiteId } from "@/lib/ids";
import { getConfigVersion } from "@/lib/services/config-service";
import { findSiteByPublicId } from "@/lib/services/site-service";

/**
 * The public runtime configuration endpoint.
 *
 * GET /api/public/sites/{publicId}/config?version=N
 *
 * `version` is REQUIRED and served exactly. There is deliberately no "latest"
 * behaviour: a website pins the version it runs in `data-wmf-config`, and
 * quietly serving a different one would mean a configuration nobody deployed
 * started executing on a live site. Since anyone can generate a configuration
 * in this MVP, that pin is the actual security boundary — so a missing version
 * is an error the runtime reports, never something to substitute around.
 *
 * The payload was built field by field by `serializeRuntimeConfig`, so no
 * database row is ever spread into it.
 */

const METHODS = "GET, OPTIONS";

/** Short enough that redeploying feels immediate; long enough to be cacheable. */
const CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { ...headers, "cache-control": "no-store" } },
  );
}

/** Parses `?version=` strictly: a bad value must not become "latest". */
function parseVersion(url: string): number | null {
  const raw = new URL(url).searchParams.get("version");
  if (raw === null) return null;
  if (!/^\d{1,7}$/.test(raw)) return null;
  const version = Number(raw);
  return version >= 1 ? version : null;
}

export async function OPTIONS(
  request: Request,
  ctx: RouteContext<"/api/public/sites/[publicId]/config">,
): Promise<Response> {
  const { publicId } = await ctx.params;
  if (!isValidPublicSiteId(publicId)) return new Response(null, { status: 404 });

  const site = await findSiteByPublicId(publicId);
  if (!site) return new Response(null, { status: 404 });

  const cors = corsFor(request.headers.get("origin"), site.origin, METHODS);
  return new Response(null, {
    status: cors.allowed ? 204 : 403,
    headers: cors.headers,
  });
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/public/sites/[publicId]/config">,
): Promise<Response> {
  const { publicId } = await ctx.params;
  const requestOrigin = request.headers.get("origin");
  const baseHeaders = { vary: "Origin" };

  if (!isValidPublicSiteId(publicId)) {
    return errorResponse(404, "NOT_FOUND", "Unknown site.", baseHeaders);
  }

  const site = await findSiteByPublicId(publicId);
  if (!site) {
    return errorResponse(404, "NOT_FOUND", "Unknown site.", baseHeaders);
  }

  const cors = corsFor(requestOrigin, site.origin, METHODS);
  if (!cors.allowed) {
    return errorResponse(
      403,
      "FORBIDDEN",
      "This configuration is only served to the site it was generated for.",
      cors.headers,
    );
  }

  const version = parseVersion(request.url);
  if (version === null) {
    return errorResponse(
      400,
      "VALIDATION_FAILED",
      "This installation snippet is missing a valid data-wmf-config version.",
      cors.headers,
    );
  }

  const found = await getConfigVersion(publicId, version);
  if (!found) {
    return errorResponse(
      404,
      "NOT_FOUND",
      `Configuration version ${version} does not exist for this site.`,
      cors.headers,
    );
  }

  return Response.json(found.config, {
    headers: { ...cors.headers, "cache-control": CACHE_CONTROL },
  });
}
