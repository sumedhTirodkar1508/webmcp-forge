import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { applyRepair, previewRepair } from "@/lib/services/repair-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({
  siteId: z.uuid(),
  action: z.enum(["preview", "apply"]),
});

/**
 * POST /api/builder/repair — propose, or apply, a mapping repair.
 *
 * `preview` re-scans and reports differences without publishing anything.
 * `apply` publishes a new immutable config version. The two are deliberately
 * separate so a repair is never silent.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    if (body.action === "preview") {
      return jsonOk({ preview: await previewRepair(session, body.siteId) });
    }

    const applied = await applyRepair(session, body.siteId);
    return jsonOk({
      applied,
      state: await getBuilderState(session, body.siteId),
    });
  } catch (error) {
    return jsonError(error);
  }
}
