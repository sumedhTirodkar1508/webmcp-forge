import { jsonError, jsonOk } from "@/lib/http/respond";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";
import { getBuilderState, getInitialBuilderState } from "@/lib/services/builder-service";
import { getBuilderSession, readRememberedSiteId } from "@/lib/session";

/** GET /api/builder/state — the current builder state for this session. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getBuilderSession();
    // No session yet simply means nothing has been started; that is not an error.
    if (!session) return jsonOk(EMPTY_BUILDER_STATE);

    const siteId = new URL(request.url).searchParams.get("siteId");
    // An explicit id is answered exactly; without one, match what the page loads.
    return jsonOk(
      siteId
        ? await getBuilderState(session, siteId)
        : await getInitialBuilderState(session, await readRememberedSiteId()),
    );
  } catch (error) {
    return jsonError(error);
  }
}
