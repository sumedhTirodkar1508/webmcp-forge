import { jsonError, jsonOk } from "@/lib/http/respond";
import { buildInsights } from "@/lib/services/insights-service";
import { getBuilderSession, requireOwnedSiteFor } from "@/lib/session";

/**
 * GET /api/builder/insights?siteId=… — owner-only operational summary.
 *
 * Ownership is enforced: this describes how the owner's own site is behaving,
 * and is not public information.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getBuilderSession();
    const siteId = new URL(request.url).searchParams.get("siteId");
    if (!session || !siteId) return jsonOk({ insights: null });

    const site = await requireOwnedSiteFor(session, siteId);
    return jsonOk({ insights: await buildInsights(site) });
  } catch (error) {
    return jsonError(error);
  }
}
