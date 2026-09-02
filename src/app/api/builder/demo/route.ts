import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { routeDemoQuestion } from "@/lib/services/demo-service";
import { requireBuilderSession } from "@/lib/session";

const bodySchema = z.object({
  siteId: z.uuid(),
  question: z.string().min(1).max(300),
});

/**
 * POST /api/builder/demo — ask the natural-language demo a question.
 *
 * Returns which tool an agent would call. The per-site question limit is
 * enforced inside the service, against the AI usage ledger, before any request
 * to Gemini is made.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    return jsonOk(await routeDemoQuestion(session, body.siteId, body.question));
  } catch (error) {
    return jsonError(error);
  }
}
