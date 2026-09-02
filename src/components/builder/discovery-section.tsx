"use client";

import { AlertTriangleIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useBuilder } from "@/components/builder/builder-provider";
import { StepShell } from "@/components/builder/step-shell";
import type { PlatformId } from "@/lib/scanner/types";

const PLATFORM_LABELS: Record<PlatformId, string> = {
  FRAMER: "Framer",
  WIX: "Wix",
  WEBFLOW: "Webflow",
  SQUARESPACE: "Squarespace",
  NEXTJS: "Next.js",
  CUSTOM: "Custom site",
  UNKNOWN: "Unknown",
};

/**
 * Step 2 — what the scan found, in plain terms first, technical details last.
 */
export function DiscoverySection() {
  const { state, lastChanged } = useBuilder();
  const discovery = state.discovery;

  return (
    <StepShell
      step={2}
      title="Review what we found"
      subtitle="A quick summary of your site's content, in plain terms."
      status={!discovery ? "locked" : state.capabilities.length > 0 ? "done" : "active"}
      lockedHint="Scan your site first."
      highlighted={lastChanged === "discovery"}
    >
      {discovery && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{PLATFORM_LABELS[discovery.platform]}</Badge>
            <span className="text-sm text-muted-foreground">
              {discovery.pagesScanned} {discovery.pagesScanned === 1 ? "page" : "pages"} scanned
            </span>
          </div>

          {discovery.lowInformation && (
            <Alert>
              <AlertTriangleIcon className="text-amber-600 dark:text-amber-400" />
              <AlertTitle>This site looks client-rendered</AlertTitle>
              <AlertDescription>
                Very little text was visible in the page&apos;s initial HTML. What we found below
                may be incomplete — consider re-scanning after checking that your site renders
                content on the server, or review the results carefully before installing.
              </AlertDescription>
            </Alert>
          )}

          {Object.keys(discovery.found).length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Object.entries(discovery.found).map(([label, count]) => (
                <div
                  key={label}
                  className="flex flex-col gap-0.5 rounded-2xl border border-border bg-muted/40 px-3 py-2"
                >
                  <span className="text-lg font-semibold text-foreground">{count}</span>
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
              ))}
            </div>
          )}

          {discovery.missing.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                Not found on your site
              </span>
              <ul className="flex flex-wrap gap-1.5">
                {discovery.missing.map((item) => (
                  <li
                    key={item}
                    className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {discovery.warnings.length > 0 && (
            <div className="flex flex-col gap-2">
              {discovery.warnings.map((warning, index) => (
                <Alert key={index}>
                  <AlertTriangleIcon className="text-amber-600 dark:text-amber-400" />
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              ))}
            </div>
          )}

          <Separator />

          <Accordion>
            <AccordionItem value="technical">
              <AccordionTrigger className="text-xs">Technical details</AccordionTrigger>
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
        </div>
      )}
    </StepShell>
  );
}
