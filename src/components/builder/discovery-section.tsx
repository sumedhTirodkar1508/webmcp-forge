"use client";

import { ArrowDownIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { useBuilder } from "@/components/builder/builder-provider";
import { Callout } from "@/components/builder/callout";
import type { PlatformId } from "@/lib/scanner/types";

const PLATFORM_LABELS: Record<PlatformId, string> = {
  FRAMER: "Framer",
  WIX: "Wix",
  WEBFLOW: "Webflow",
  SQUARESPACE: "Squarespace",
  NEXTJS: "Next.js",
  CUSTOM: "Custom site",
  UNKNOWN: "Unknown platform",
};

/**
 * What the scan found, in plain terms first, technical details last.
 *
 * This used to be its own numbered card ("Step 2 — Review what we found"),
 * which made the cards count to six while the progress bar counted five: the
 * bar said Install was step 3 and the Install card said step 4. A scan and its
 * result are one step, so the result now lives inside the Scan card.
 */
export function ScanResults() {
  const { state } = useBuilder();
  const discovery = state.discovery;

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {discovery
          ? `Scan complete. ${discovery.pagesScanned} ${discovery.pagesScanned === 1 ? "page" : "pages"} scanned.`
          : ""}
      </p>
      {discovery && (
        <section
          id="step-review"
          aria-labelledby="scan-results-title"
          className="mt-5 flex flex-col gap-4 border-t border-border pt-5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="scan-results-title" className="text-sm font-semibold text-foreground">
              What we found
            </h3>
            <Badge variant="secondary">{PLATFORM_LABELS[discovery.platform]}</Badge>
            <span className="text-xs text-muted-foreground">
              {discovery.pagesScanned} {discovery.pagesScanned === 1 ? "page" : "pages"} read
            </span>
          </div>

          {discovery.lowInformation && (
            <Callout title="This site may load its content with JavaScript">
              Very little text was in the page&apos;s initial HTML, so what we found may be
              incomplete. Review the results below before installing.
            </Callout>
          )}

          {Object.keys(discovery.found).length > 0 && (
            <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {Object.entries(discovery.found).map(([label, count]) => (
                <div
                  key={label}
                  className="flex flex-col-reverse gap-0.5 rounded-2xl border border-border bg-muted/40 px-3.5 py-3"
                >
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                    {count}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {discovery.missing.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Not found on your site
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {discovery.missing.map((item) => (
                  <li
                    key={item}
                    className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {discovery.warnings.length > 0 && (
            <Callout
              title={
                discovery.warnings.length === 1
                  ? "One thing to know"
                  : `${discovery.warnings.length} things to know`
              }
            >
              <ul className="flex flex-col gap-1">
                {discovery.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </Callout>
          )}

          {!state.installation && (
            <a
              href="#step-choose"
              className="inline-flex items-center gap-1.5 self-start rounded-md text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Looks right? Choose what agents can do
              <ArrowDownIcon aria-hidden className="size-4" />
            </a>
          )}

          <Accordion>
            <AccordionItem value="technical">
              <AccordionTrigger className="text-xs text-muted-foreground">
                Technical details
              </AccordionTrigger>
              <AccordionContent className="flex flex-col gap-3 text-xs text-muted-foreground">
                <div>
                  <p className="font-medium text-foreground">Route patterns</p>
                  {discovery.routePatterns.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 font-mono">
                      {discovery.routePatterns.map((pattern) => (
                        <li key={pattern} className="break-all">
                          {pattern}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1">None recorded.</p>
                  )}
                </div>
                <div>
                  <p className="font-medium text-foreground">AI interpretation</p>
                  <p className="mt-1">
                    {discovery.usedAi
                      ? `Model: ${discovery.aiModel ?? "unknown"}${discovery.aiFellBack ? " (fell back after an initial failure)" : ""}`
                      : "No AI model was used for this scan."}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Platform confidence</p>
                  <p className="mt-1">{Math.round(discovery.platformConfidence * 100)}%</p>
                </div>
                {discovery.scannedAt && (
                  <div>
                    <p className="font-medium text-foreground">Scanned at</p>
                    <p className="mt-1">{new Date(discovery.scannedAt).toLocaleString()}</p>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>
      )}
    </>
  );
}
