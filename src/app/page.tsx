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
import { getEnv } from "@/lib/env";
import { getInitialBuilderState } from "@/lib/services/builder-service";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";
import { getBuilderSession, readRememberedSiteId } from "@/lib/session";

// This page reads the builder session cookie on every request.
export const dynamic = "force-dynamic";

export default async function BuilderPage() {
  const session = await getBuilderSession();
  const state = session
    ? await getInitialBuilderState(session, await readRememberedSiteId())
    : EMPTY_BUILDER_STATE;
  const demoUrl = getEnv().DEMO_PORTFOLIO_URL || null;

  return (
    <BuilderProvider initialState={state}>
      <main
        id="main"
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pb-16 pt-10 sm:px-6 sm:pt-14"
      >
        {/* An owner coming back to a site they've already scanned doesn't need
            the pitch again — just a reminder of where they are. */}
        <ForgeHero compact={state.discovery !== null} />

        <div className="flex flex-col gap-6">
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
