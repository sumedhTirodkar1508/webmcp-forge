import { z } from "zod";

import { assertSameOrigin, jsonError, jsonOk, readJson } from "@/lib/http/respond";
import {
  closeLiveTest,
  getLiveTestState,
  startLiveTest,
} from "@/lib/services/live-test-service";
import { getBuilderSession, requireBuilderSession } from "@/lib/session";

const startSchema = z.object({ siteId: z.uuid() });
const stopSchema = z.object({ siteId: z.uuid(), action: z.literal("stop") });

/** GET /api/builder/live-test?siteId=… — is a live target connected? */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getBuilderSession();
    const siteId = new URL(request.url).searchParams.get("siteId");
    if (!session || !siteId) {
      return jsonOk({ connected: false, expiresAt: null, availableTools: [] });
    }
    // Ownership matters even for a read: this reveals whether a channel exists.
    const owned = await import("@/lib/session").then((m) =>
      m.requireOwnedSiteFor(session, siteId),
    );
    return jsonOk(await getLiveTestState(owned.id));
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * POST /api/builder/live-test — open a live agent test session, or close one.
 *
 * The raw token is returned exactly once, for the browser to open against the
 * owner's own portfolio. Only its hash is stored.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const raw = await request.clone().json().catch(() => ({}));
    const session = await requireBuilderSession();

    if ((raw as { action?: string }).action === "stop") {
      const body = await readJson(request, stopSchema);
      await closeLiveTest(session, body.siteId);
      return jsonOk({ connected: false });
    }

    const body = await readJson(request, startSchema);
    const issue = await startLiveTest(session, body.siteId);
    return jsonOk({
      testUrl: issue.testUrl,
      expiresAt: issue.expiresAt.toISOString(),
    });
  } catch (error) {
    return jsonError(error);
  }
}
