import { z } from "zod";

import { CAPABILITY_IDS } from "@/lib/capabilities/catalogue";
import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { setCapabilityEnabled } from "@/lib/services/config-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({
  siteId: z.uuid(),
  capabilityId: z.enum(CAPABILITY_IDS),
  enabled: z.boolean(),
});

/** POST /api/builder/capabilities — turn one capability on or off. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const result = await setCapabilityEnabled(
      session,
      body.siteId,
      body.capabilityId,
      body.enabled,
    );

    return jsonOk({
      state: await getBuilderState(session, body.siteId),
      applied: result.applied,
      message: result.message,
    });
  } catch (error) {
    return jsonError(error);
  }
}
