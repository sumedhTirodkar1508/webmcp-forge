import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { publishConfiguration } from "@/lib/services/config-service";
import { getInstallInstructions } from "@/lib/services/install-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({ siteId: z.uuid() });

/**
 * POST /api/builder/publish — freeze the current settings and publish them.
 *
 * This is "Generate installation". The snippet it produces never changes, so
 * publishing again later updates what agents can do without the owner touching
 * their website.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const result = await publishConfiguration(session, body.siteId);

    return jsonOk({
      state: await getBuilderState(session, body.siteId),
      instructions: getInstallInstructions(result.site.platform),
    });
  } catch (error) {
    return jsonError(error);
  }
}
