import { corsFor } from "@/lib/http/cors";
import { isValidPublicSiteId } from "@/lib/ids";
import { getPublishedConfig } from "@/lib/services/config-service";

/**
 * The public runtime configuration endpoint.
 *
 * GET /api/public/sites/{publicId}/config
 *
 * This is the only route by which configuration reaches the open internet, and
 * it serves exactly one thing: the site's currently published version. Drafts
 * are unreachable by construction — `getPublishedConfig` reads through
 * `Site.publishedConfigVersionId`, which only publishing ever sets — and the
 * payload was built field by field by `serializeRuntimeConfig`, so no database
 * row is ever spread into it.
 */

const METHODS = "GET, OPTIONS";

/** Short enough that publishing feels immediate; long enough to be cacheable. */
const CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=60";

function notFound(headers: Record<string, string>): Response {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "No published configuration for that site." } },
    { status: 404, headers: { ...headers, "cache-control": "no-store" } },
  );
}

export async function OPTIONS(
  request: Request,
  ctx: RouteContext<"/api/public/sites/[publicId]/config">,
): Promise<Response> {
  const { publicId } = await ctx.params;
  const requestOrigin = request.headers.get("origin");

  if (!isValidPublicSiteId(publicId)) {
    return new Response(null, { status: 404 });
  }

  const published = await getPublishedConfig(publicId);
  if (!published) return new Response(null, { status: 404 });

  const cors = corsFor(requestOrigin, published.origin, METHODS);
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

  // Validate the shape before touching the database.
  if (!isValidPublicSiteId(publicId)) {
    return notFound({ vary: "Origin" });
  }

  const published = await getPublishedConfig(publicId);
  if (!published) return notFound({ vary: "Origin" });

  const cors = corsFor(requestOrigin, published.origin, METHODS);
  if (!cors.allowed) {
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "This configuration is only served to the site it was published for.",
        },
      },
      { status: 403, headers: cors.headers },
    );
  }

  return Response.json(published.config, {
    headers: { ...cors.headers, "cache-control": CACHE_CONTROL },
  });
}
