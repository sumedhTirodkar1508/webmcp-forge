import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { buildStateForSite } from "@/lib/services/builder-service";
import { setTargetUrl } from "@/lib/services/site-service";
import { rememberCurrentSite, requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({
  url: z.string().min(1).max(2000),
  siteId: z.uuid().optional(),
});

/** POST /api/builder/target — point the builder at a portfolio. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const { site } = await setTargetUrl(session, body.url);
    await rememberCurrentSite(site.id);
    return jsonOk(await buildStateForSite(site));
  } catch (error) {
    return jsonError(error);
  }
}
