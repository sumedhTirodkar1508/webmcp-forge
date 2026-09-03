"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBuilder } from "@/components/builder/builder-provider";
import { StepShell } from "@/components/builder/step-shell";
import type { PlatformId } from "@/lib/scanner/types";

/**
 * Platform install instructions, mirrored from `src/lib/services/install-service.ts`.
 *
 * That file is server-only (imports "server-only"), so it cannot be imported
 * from this client component. Keep this in sync by hand if the steps there
 * change — nothing here is computed, it is copied.
 */
interface InstallInstructions {
  platformLabel: string;
  summary: string;
  steps: string[];
  notes: string[];
  docsUrl?: string;
}

const CUSTOM_INSTRUCTIONS: InstallInstructions = {
  platformLabel: "Custom site",
  summary: "Paste the snippet into the <head> of every page.",
  steps: [
    "Open the HTML template that every page of your site shares.",
    "Paste the snippet just before the closing </head> tag.",
    "Deploy or publish your site.",
    "Come back here and press Check Installation.",
  ],
  notes: [
    "If your site is built from separate HTML files, add the snippet to each one — or to the shared layout/partial if you have one.",
    "The script tag itself stays in place, but the version it pins does not: when you generate a new configuration, update data-wmf-config to the new version and redeploy your site.",
  ],
};

const INSTALL_INSTRUCTIONS_BY_PLATFORM: Record<PlatformId, InstallInstructions> = {
  FRAMER: {
    platformLabel: "Framer",
    summary: "Add the snippet to your site's custom code, in the End of <head> slot.",
    steps: [
      "In Framer, open your project and go to Site Settings.",
      "Select General, then scroll to Custom Code.",
      "Paste the snippet into the “End of <head> tag” box.",
      "Press Publish — custom code only runs on the published site, not in the editor.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Custom code does not run inside the Framer canvas or preview. You must publish first.",
      "Framer sites are single-page apps: the runtime follows in-app navigation on its own.",
    ],
    docsUrl: "https://www.framer.com/help/articles/how-can-i-add-custom-code-to-my-site/",
  },
  WIX: {
    platformLabel: "Wix",
    summary: "Add the snippet as a custom code element that loads on all pages.",
    steps: [
      "In your Wix dashboard, go to Settings, then Custom Code (under Advanced).",
      "Press “+ Add Custom Code”.",
      "Paste the snippet into the code box.",
      "Set “Add Code to Pages” to All pages, and “Place Code in” to Head.",
      "Press Apply, then publish your site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Custom code requires a Wix Premium plan with a connected domain.",
      "Code added this way does not run on the free wixsite.com preview in all cases — publish to your real domain if verification fails.",
    ],
    docsUrl: "https://support.wix.com/en/article/embedding-custom-code-on-your-site",
  },
  WEBFLOW: {
    platformLabel: "Webflow",
    summary: "Add the snippet to your project's head code, then publish.",
    steps: [
      "In Webflow, open Site Settings, then the Custom Code tab.",
      "Paste the snippet into “Head Code”.",
      "Press Save Changes.",
      "Publish your site — custom code only runs on the published site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Head Code is only available on paid site plans.",
      "If you only want the runtime on some pages, use that page's own Page Settings instead.",
    ],
    docsUrl: "https://university.webflow.com/lesson/custom-code-in-the-head-and-body-tags",
  },
  SQUARESPACE: {
    platformLabel: "Squarespace",
    summary: "Add the snippet to Code Injection, in the Header field.",
    steps: [
      "Open Settings, then Advanced, then Code Injection.",
      "Paste the snippet into the Header field.",
      "Press Save.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "Code Injection requires a Business plan or higher.",
      "Code Injection does not run in the Squarespace editor preview.",
    ],
  },
  NEXTJS: {
    platformLabel: "Next.js site",
    summary: "Add the snippet to your root layout.",
    steps: [
      "Open your root layout (app/layout.tsx) or _document if you use the Pages Router.",
      "Add the script using next/script with the afterInteractive strategy, or paste the raw tag into <head>.",
      "Deploy your site.",
      "Come back here and press Check Installation.",
    ],
    notes: [
      "With next/script, pass the site id as a data-wmf-site prop so it reaches the rendered tag.",
      "Client-side route changes are handled by the runtime; you do not need to re-add anything per page.",
    ],
  },
  CUSTOM: CUSTOM_INSTRUCTIONS,
  UNKNOWN: CUSTOM_INSTRUCTIONS,
};

/**
 * Step 4 — generate the install snippet and show how to add it for this
 * site's platform.
 */
export function InstallSection() {
  const { state, phase, actions, lastChanged } = useBuilder();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const installation = state.installation;
  const generating = phase === "publishing";

  async function handleCopy() {
    if (!installation) return;
    setCopyFailed(false);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(installation.scriptTag);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = installation.scriptTag;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  const instructions = installation
    ? INSTALL_INSTRUCTIONS_BY_PLATFORM[installation.platform]
    : null;

  return (
    <StepShell
      step={4}
      title="Install the snippet"
      subtitle="One script tag, added once, on every page of your site."
      status={state.capabilities.length === 0 ? "locked" : installation ? "done" : "active"}
      lockedHint="Choose your capabilities first."
      highlighted={lastChanged === "install"}
    >
      <p aria-live="polite" className="sr-only">
        {copied ? "Snippet copied to clipboard." : copyFailed ? "Copying failed. Select the snippet and copy it manually." : ""}
      </p>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Install the runtime once. When you generate a new configuration, update{" "}
          <code className="font-mono">data-wmf-config</code> to the new version and redeploy
          your site.
        </p>

        {!installation && (
          <Button
            type="button"
            onClick={() => void actions.generateInstallation()}
            disabled={generating}
            className="self-start"
          >
            {generating && <Loader2Icon className="animate-spin" />}
            {generating ? "Generating…" : "Generate installation"}
          </Button>
        )}

        {installation && instructions && (
          <div className="flex flex-col gap-4">
            {/*
              The distinction that matters: generating a configuration in Forge
              does not change anything on the live website. Only the version
              pinned in the deployed snippet runs.
            */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border border-border bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">
                Installed on your site:{" "}
                <span className="font-medium text-foreground">
                  {installation.installedVersion !== null
                    ? `v${installation.installedVersion}`
                    : "not detected yet"}
                </span>
              </span>
              <span className="text-muted-foreground">
                Latest generated in Forge:{" "}
                <span className="font-medium text-foreground">
                  v{installation.latestGeneratedVersion}
                </span>
              </span>
            </div>

            {installation.installedVersion !== null &&
              installation.installedVersion !== installation.latestGeneratedVersion && (
                <p
                  role="status"
                  aria-live="polite"
                  className="rounded-2xl border border-border bg-card p-3 text-sm text-muted-foreground"
                >
                  This configuration will not affect your live site until you update{" "}
                  <code className="font-mono">data-wmf-config</code> to{" "}
                  <span className="font-medium text-foreground">
                    {installation.latestGeneratedVersion}
                  </span>{" "}
                  and redeploy.
                </p>
              )}

            {installation.needsRegeneration && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium text-foreground">Your scan is newer than this configuration.</p>
                <p className="mt-1 text-muted-foreground">
                  Generate a new configuration to capture the latest selectors and capability
                  recommendations. You will then need to update the version number in your
                  script tag and redeploy your site.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void actions.generateInstallation()}
                  disabled={generating}
                >
                  {generating && <Loader2Icon className="animate-spin" />}
                  {generating ? "Regenerating…" : "Regenerate configuration"}
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Your script tag</span>
                <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-2xl border border-border bg-muted/40 p-3 text-xs break-all whitespace-pre-wrap">
                {installation.scriptTag}
              </pre>
              {copyFailed && (
                <p className="text-xs text-muted-foreground">
                  Copy didn&apos;t work automatically — select the text above and copy it manually.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-foreground">
                {instructions.platformLabel}: {instructions.summary}
              </p>
              <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                {instructions.steps.map((step, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="text-foreground">{index + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              {instructions.notes.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                  {instructions.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
              {instructions.docsUrl && (
                <a
                  href={instructions.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary underline underline-offset-3"
                >
                  Platform documentation
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </StepShell>
  );
}
