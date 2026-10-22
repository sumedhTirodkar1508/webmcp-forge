import { AgentStatus } from "@/components/builder/agent-status";
import { AskAgentSection } from "@/components/builder/ask-agent-section";
import { BuilderProvider } from "@/components/builder/builder-provider";
import { CapabilitiesSection } from "@/components/builder/capabilities-section";
import { ForgeHero } from "@/components/builder/forge-hero";
import { InsightsSection } from "@/components/builder/insights-section";
import { InstallSection } from "@/components/builder/install-section";
import { ProgressStepper } from "@/components/builder/progress-stepper";
import { TargetSection } from "@/components/builder/target-section";
import { VerifySection } from "@/components/builder/verify-section";
import { ServiceNotice } from "@/components/builder/service-notice";
import { getEnv } from "@/lib/env";
import {
  DATABASE_UNAVAILABLE_MESSAGE,
  isDatabaseUnavailable,
  summarizeDatabaseError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getInitialBuilderState } from "@/lib/services/builder-service";
import { EMPTY_BUILDER_STATE, type BuilderState } from "@/lib/services/types";
import { getBuilderSession, readRememberedSiteId } from "@/lib/session";

// This page reads the builder session cookie on every request.
export const dynamic = "force-dynamic";

/**
 * Loads the builder state, or reports that the database can't be reached.
 *
 * A database that is briefly unreachable — a serverless database waking from
 * idle, say — used to take the whole page down with a generic error. The page
 * now renders, says what is going on, and every action retries for real.
 */
async function loadInitialState(): Promise<{ state: BuilderState; notice: string | null }> {
  try {
    const session = await getBuilderSession();
    const state = session
      ? await getInitialBuilderState(session, await readRememberedSiteId())
      : EMPTY_BUILDER_STATE;
    return { state, notice: null };
  } catch (error) {
    if (!isDatabaseUnavailable(error)) throw error;
    logger.warn("database_unavailable_on_page_load", { cause: summarizeDatabaseError(error) });
    return { state: EMPTY_BUILDER_STATE, notice: DATABASE_UNAVAILABLE_MESSAGE };
  }
}

export default async function BuilderPage() {
  const { state, notice } = await loadInitialState();
  const demoUrl = getEnv().DEMO_PORTFOLIO_URL || null;

  return (
    <BuilderProvider initialState={state}>
      <main
        id="main"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pb-16 pt-10 sm:px-6 sm:pt-14"
      >
        <ForgeHero />

        <div className="flex flex-col gap-6">
          {notice && <ServiceNotice message={notice} />}
          <ProgressStepper />
          <AgentStatus />

          <TargetSection demoUrl={demoUrl} />
          <CapabilitiesSection />
          <InstallSection />
          <VerifySection />
          <AskAgentSection />
          <InsightsSection />
        </div>
      </main>
    </BuilderProvider>
  );
}
