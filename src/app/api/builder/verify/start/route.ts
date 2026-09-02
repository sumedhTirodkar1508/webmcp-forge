import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { createVerificationChallenge } from "@/lib/services/verification-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({ siteId: z.uuid() });

/**
 * POST /api/builder/verify/start — mint a single-use verification challenge.
 *
 * The raw challenge is returned exactly once, for the browser to place in the
 * URL it opens against the owner's portfolio. Only its hash is stored.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    const issue = await createVerificationChallenge(session, body.siteId);

    return jsonOk({
      verifyUrl: issue.verifyUrl,
      expiresAt: issue.expiresAt.toISOString(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
