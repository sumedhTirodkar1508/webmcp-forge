import { jsonError, jsonOk } from "@/lib/http/respond";
import { getBuilderState } from "@/lib/services/builder-service";
import { getBuilderSession } from "@/lib/session";

/** GET /api/builder/verify?siteId=… — poll for the verification result. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getBuilderSession();
    if (!session) return jsonOk({ verification: null });

    const siteId = new URL(request.url).searchParams.get("siteId") ?? undefined;
    const state = await getBuilderState(session, siteId);
    return jsonOk({ verification: state.verification });
  } catch (error) {
    return jsonError(error);
  }
}
