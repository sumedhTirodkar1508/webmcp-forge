import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { scanSite } from "@/lib/services/scan-service";
import { requireBuilderSession } from "@/lib/session";

/**
 * Upper bound on this request, in seconds.
 *
 * Sized to the internal budgets rather than left to the platform default: the
 * crawl and every AI step now stop themselves inside these limits, so a slow
 * site degrades to a partial scan (or an honest "unavailable") instead of a
 * killed function and a generic error.
 */
export const maxDuration = 60;


const bodySchema = z.object({ siteId: z.uuid() });

/**
 * POST /api/builder/scan — crawl and interpret the site.
 *
 * Synchronous by design: a portfolio scan is a handful of bounded requests plus
 * one Gemini call, which fits comfortably inside a request. A job queue would be
 * infrastructure without a problem to solve at this size.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const outcome = await scanSite(session, body.siteId);
    return jsonOk(await getBuilderState(session, outcome.site.id));
  } catch (error) {
    return jsonError(error);
  }
}
