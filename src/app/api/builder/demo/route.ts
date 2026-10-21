import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import { askAgent } from "@/lib/services/agent-chat-service";
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


const bodySchema = z.object({
  siteId: z.uuid(),
  question: z.string().min(1).max(300),
});

/**
 * POST /api/builder/demo — ask the readiness assistant a question.
 *
 * Answers operational questions from the readiness snapshot, and content
 * questions by executing a real read-only WebMCP tool through the live test
 * relay when one is connected. The per-site lifetime limit is enforced inside
 * the service, against the AI usage ledger, before anything reaches Gemini.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readJson(request, bodySchema);
    const session = await requireBuilderSession();

    return jsonOk(await askAgent(session, body.siteId, body.question));
  } catch (error) {
    return jsonError(error);
  }
}
