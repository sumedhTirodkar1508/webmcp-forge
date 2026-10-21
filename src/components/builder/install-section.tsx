"use client";

import { useState } from "react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleDashedIcon,
  CopyIcon,
  Loader2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBuilder } from "@/components/builder/builder-provider";
import { Callout } from "@/components/builder/callout";
import { SectionError } from "@/components/builder/section-error";
import { isInstalled, stepStateFor } from "@/components/builder/progress";
import { StepShell } from "@/components/builder/step-shell";
import type { PlatformId } from "@/lib/scanner/types";
import { cn } from "@/lib/utils";

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
    setCopied(false);
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
        try {
          if (!document.execCommand("copy")) throw new Error("Copy failed");
        } finally {
          textarea.remove();
        }
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

  // A snippet is on the site, but it names some other Forge site.
  const detected = state.discovery?.installedSnippet ?? null;
  const foreignSnippet = detected && !detected.matchesThisSite ? detected : null;

  const installed = installation?.installedVersion ?? null;
  const outdated =
    installation !== null && installed !== null && installed !== installation.latestGeneratedVersion;

  return (
    <StepShell
      step={3}
      id="step-install"
      title="Install the snippet"
      subtitle="Generate your snippet, then paste it into every page of your site and publish."
      // Done only once the snippet is actually seen on the site (or verified).
      // Generating a configuration installs nothing, and this used to show a
      // checkmark the moment one was generated.
      status={
        state.capabilities.length === 0 ? "locked" : isInstalled(state) ? "done" : "active"
      }
      current={stepStateFor(state, "install") === "current"}
      lockedHint="Scan your site first — then you can choose capabilities and generate a snippet."
      highlighted={lastChanged === "install"}
    >
      <p aria-live="polite" className="sr-only">
        {copied ? "Snippet copied to clipboard." : copyFailed ? "Copying failed. Select the snippet and copy it manually." : ""}
      </p>
      <div className="flex flex-col gap-5">
        <SectionError sections={["install"]} />

        {!installation && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              We&apos;ll save your choices as version 1 and give you one script tag to add to your
              site. Nothing changes on your site until you paste it in and publish.
            </p>
            <Button
              type="button"
              size="lg"
              onClick={() => void actions.generateInstallation().catch(() => {})}
              disabled={generating}
            >
              {generating && <Loader2Icon className="animate-spin" />}
              {generating ? "Generating…" : "Generate my snippet"}
            </Button>
          </div>
        )}

        {installation && instructions && (
          <div className="flex flex-col gap-5">
            {/*
              The distinction that matters: generating a configuration in Forge
              does not change anything on the live website. Only the version
              pinned in the deployed snippet runs.
            */}
            <dl className="grid gap-2.5 sm:grid-cols-2">
              <div
                className={cn(
                  "flex flex-col gap-1 rounded-2xl border px-3.5 py-3",
                  installed !== null && !outdated
                    ? "border-success/25 bg-success-soft"
                    : "border-border bg-muted/40",
                )}
              >
                <dt className="text-xs text-muted-foreground">On your live site</dt>
                <dd className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  {installed !== null ? (
                    <>
                      <CheckIcon aria-hidden className="size-4 text-success" strokeWidth={2.5} />
                      Version {installed}
                    </>
                  ) : (
                    <>
                      <CircleDashedIcon aria-hidden className="size-4 text-muted-foreground" />
                      Not detected yet
                    </>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-1 rounded-2xl border border-border bg-muted/40 px-3.5 py-3">
                <dt className="text-xs text-muted-foreground">Latest generated in Forge</dt>
                <dd className="text-sm font-semibold text-foreground">
                  Version {installation.latestGeneratedVersion}
                </dd>
              </div>
            </dl>

            {installed === null && !foreignSnippet && (
              <p className="-mt-2 text-xs text-muted-foreground">
                We look for the snippet each time we scan your site. After you publish it, use{" "}
                <a href="#step-verify" className="font-medium text-foreground underline underline-offset-3">
                  Check installation
                </a>{" "}
                below to confirm.
              </p>
            )}

            {outdated && (
              <Callout role="status" title="Your live site is running an older version">
                Change <code className="font-mono text-foreground">data-wmf-config</code> in your
                script tag to{" "}
                <span className="font-medium text-foreground">
                  {installation.latestGeneratedVersion}
                </span>{" "}
                and republish. Until then, your site keeps using version {installed}.
              </Callout>
            )}

            {foreignSnippet && (
              <Callout role="status" title="Your site has a WebMCP Forge snippet — but for a different site">
                The snippet we found uses{" "}
                <code className="break-all font-mono text-foreground">{foreignSnippet.siteId}</code>,
                not this site&apos;s{" "}
                <code className="break-all font-mono text-foreground">{installation.publicId}</code>.
                It may have been copied from another site or an earlier test. Replace it with the
                snippet below so this configuration is the one your site runs.
              </Callout>
            )}

            {installation.needsRegeneration && (
              <Callout title="Your configuration needs updating">
                Generate a new configuration to include your latest scan and capability choices. Then update the
                version number in your script tag and republish your site.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 flex"
                  onClick={() => void actions.generateInstallation().catch(() => {})}
                  disabled={generating}
                >
                  {generating && <Loader2Icon className="animate-spin" />}
                  {generating ? "Regenerating…" : "Regenerate configuration"}
                </Button>
              </Callout>
            )}

            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-sm">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-2">
                <span className="text-xs text-zinc-400">
                  Your script tag · paste into <code className="font-mono">&lt;head&gt;</code>
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCopy}
                  className="h-7 bg-white/10 text-zinc-100 hover:bg-white/20"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-x-auto px-3.5 py-3 font-mono text-xs leading-relaxed">
                <code>{installation.scriptTag}</code>
              </pre>
            </div>
            {copyFailed && (
              <p className="-mt-3 text-xs text-muted-foreground">
                Copy didn&apos;t work automatically — select the text above and copy it manually.
              </p>
            )}

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-semibold text-foreground">
                  How to add it on {instructions.platformLabel}
                </h3>
                <p className="text-sm text-muted-foreground">{instructions.summary}</p>
              </div>
              <ol className="flex flex-col gap-2.5">
                {instructions.steps.map((step, index) => (
                  <li key={index} className="flex gap-3 text-sm text-foreground">
                    <span
                      aria-hidden
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground"
                    >
                      {index + 1}
                    </span>
                    <span className="pt-px">{step}</span>
                  </li>
                ))}
              </ol>
              <ul className="flex flex-col gap-1.5 rounded-2xl bg-muted/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
                {instructions.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
                {/* Every platform needs this; the custom-site notes already say it. */}
                {!instructions.notes.some((note) => note.includes("data-wmf-config")) && (
                  <li>
                    Install the script once. When you generate a new configuration later, update{" "}
                    <code className="font-mono text-foreground">data-wmf-config</code> to the new
                    version and republish.
                  </li>
                )}
              </ul>
              {instructions.docsUrl && (
                <a
                  href={instructions.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 self-start text-xs font-medium text-foreground underline underline-offset-3"
                >
                  {instructions.platformLabel} help article
                  <ArrowUpRightIcon aria-hidden className="size-3.5" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </StepShell>
  );
}
