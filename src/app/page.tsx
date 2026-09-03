import { AgentStatus } from "@/components/builder/agent-status";
import { AskAgentSection } from "@/components/builder/ask-agent-section";
import { BuilderProvider } from "@/components/builder/builder-provider";
import { CapabilitiesSection } from "@/components/builder/capabilities-section";
import { DiscoverySection } from "@/components/builder/discovery-section";
import { InsightsSection } from "@/components/builder/insights-section";
import { InstallSection } from "@/components/builder/install-section";
import { TargetSection } from "@/components/builder/target-section";
import { VerifySection } from "@/components/builder/verify-section";
import { getBuilderState } from "@/lib/services/builder-service";
import { EMPTY_BUILDER_STATE } from "@/lib/services/types";
import { getBuilderSession } from "@/lib/session";

// This page reads the builder session cookie on every request.
export const dynamic = "force-dynamic";

export default async function BuilderPage() {
  const session = await getBuilderSession();
  const state = session ? await getBuilderState(session) : EMPTY_BUILDER_STATE;

  return (
    <BuilderProvider initialState={state}>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-12 sm:px-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            WebMCP Forge
          </h1>
          <p className="text-lg text-muted-foreground">
            Turn your portfolio into a site AI agents can actually use.
          </p>
          <p className="max-w-xl text-sm text-muted-foreground">
            Point us at your site, review what we found, choose what agents can do, install one
            snippet, then verify it&apos;s live.
          </p>
        </header>

        <AgentStatus />

        <div className="flex flex-col gap-6">
          <TargetSection />
          <DiscoverySection />
          <CapabilitiesSection />
          <InstallSection />
          <VerifySection />
          <AskAgentSection />
          <InsightsSection />
        </div>
      </div>
    </BuilderProvider>
  );
}
