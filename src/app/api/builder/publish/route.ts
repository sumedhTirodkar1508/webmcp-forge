import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { generateConfiguration } from "@/lib/services/config-service";
import { getInstallInstructions } from "@/lib/services/install-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({ siteId: z.uuid() });

/**
 * POST /api/builder/publish — freeze the current draft into a new version.
 *
 * This GENERATES a configuration; it does not activate one. The website runs
 * whichever version its snippet pins in `data-wmf-config`, so a newly
 * generated version only takes effect once that snippet is updated and the
 * website redeployed.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const result = await generateConfiguration(session, body.siteId);

    return jsonOk({
      state: await getBuilderState(session, body.siteId),
      instructions: getInstallInstructions(result.site.platform),
      generatedVersion: result.configVersion.version,
    });
  } catch (error) {
    return jsonError(error);
  }
}
