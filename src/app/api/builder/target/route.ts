import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { setTargetUrl } from "@/lib/services/site-service";
import { requireBuilderSession } from "@/lib/session";

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

    const { site } = await setTargetUrl(session, body.url, body.siteId);
    return jsonOk(await getBuilderState(session, site.id));
  } catch (error) {
    return jsonError(error);
  }
}
