import { jsonError, jsonOk } from "@/lib/http/respond";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";
import { getBuilderState } from "@/lib/services/builder-service";
import { getBuilderSession } from "@/lib/session";

/** GET /api/builder/state — the current builder state for this session. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getBuilderSession();
    // No session yet simply means nothing has been started; that is not an error.
    if (!session) return jsonOk(EMPTY_BUILDER_STATE);

    const siteId = new URL(request.url).searchParams.get("siteId") ?? undefined;
    return jsonOk(await getBuilderState(session, siteId));
  } catch (error) {
    return jsonError(error);
  }
}
