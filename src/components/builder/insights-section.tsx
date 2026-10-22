"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2 } from "lucide-react";

import { useBuilder } from "@/components/builder/builder-provider";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/**
 * Operational insights, for the site's owner only.
 *
 * Explicitly not visitor analytics: nothing here counts page views, records an
 * IP, or reports anything a visitor did. It summarises the owner's own scans,
 * verification checks and AI questions — data Forge already had.
 *
 * Collapsed by default so the main five-step flow stays the focus.
 */

interface Insights {
  scans: {
    total: number;
    lastDurationMs: number | null;
    lastModel: string | null;
    lastFellBack: boolean;
    pagesScanned: number;
    counts: Record<string, number>;
  };
  verification: {
    total: number;
    lastStatus: string | null;
    lastCheckedAt: string | null;
    runtimeVersion: string | null;
    webmcpAvailable: boolean;
    nativeToolCount: number;
    conflictCount: number;
    forgeAddedCount: number;
    liveCounts: Record<string, number>;
  };
  ai: {
    questionsUsed: number;
    questionsRemaining: number;
    lastModel: string | null;
    lastLatencyMs: number | null;
  };
  contact: { formDetected: boolean; support: string | null; sendEnabled: boolean };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right text-xs font-medium text-foreground break-words">{value}</dd>
    </div>
  );
}

/**
 * Readable names for the count keys and enum values the API returns. The panel
 * used to print them raw ("skillGroups", "live skillGroups", "SUCCESS").
 */
const COUNT_LABELS: Record<string, string> = {
  projects: "Projects",
  skills: "Skills",
  skillGroups: "Skill groups",
  experience: "Experience",
  education: "Education",
  navigation: "Menu links",
};

function countLabel(key: string): string {
  return COUNT_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

const OUTCOME_LABELS: Record<string, string> = {
  SUCCESS: "Passed",
  PARTIAL: "Passed with warnings",
  FAILED: "Failed",
};

const SUPPORT_LABELS: Record<string, string> = {
  SUPPORTED: "Supported",
  UNSUPPORTED: "Not supported",
  UNCERTAIN: "Uncertain",
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function InsightsSection() {
  const { state } = useBuilder();
  /*
   * Stored WITH the site it describes.
   *
   * Tagging the data rather than clearing it on change means the previous
   * site's metrics can never be rendered under the new one — they simply stop
   * matching — and no state has to be reset synchronously inside an effect.
   */
  const [entry, setEntry] = useState<{ siteId: string; insights: Insights | null } | null>(
    null,
  );

  const current = entry?.siteId === state.siteId ? entry : null;
  const insights = current?.insights ?? null;
  const loaded = current !== null;

  // No state is set before the first `await`: doing so synchronously inside an
  // effect triggers a cascading render.
  /*
   * Loading is keyed on the site id and cancelled when it changes.
   *
   * A slow response for the previous site would otherwise be rendered as this
   * site's metrics — the panel would show the demo's scan counts under
   * production. The cleanup runs on every site change, so a late response is
   * simply dropped.
   */
  useEffect(() => {
    const siteId = state.siteId;
    if (!siteId) return;

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/builder/insights?siteId=${encodeURIComponent(siteId)}`,
        );
        if (cancelled || !response.ok) return;
        const body = (await response.json()) as { insights: Insights | null };
        if (cancelled) return;
        setEntry({ siteId, insights: body.insights });
      } catch {
        if (!cancelled) setEntry({ siteId, insights: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.siteId, state.status, state.verification?.checkedAt]);

  if (!state.siteId) return null;

  return (
    <Accordion className="rounded-4xl border border-border bg-card/60">
      <AccordionItem value="insights" className="border-none">
        <AccordionTrigger className="px-5 text-sm">
          <span className="flex items-center gap-2">
            <Activity aria-hidden className="size-4 text-muted-foreground" />
            Activity &amp; diagnostics
            <span className="hidden font-normal text-muted-foreground sm:inline">· your own activity, no visitor data</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="px-5 pb-5">
          <p aria-live="polite" className="sr-only">
            {loaded ? "Insights loaded." : "Loading insights."}
          </p>

          {!loaded && !insights ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Loading…
            </p>
          ) : !insights ? (
            <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Scans
                </h3>
                <dl className="divide-y divide-border">
                  <Row label="Total scans" value={String(insights.scans.total)} />
                  <Row label="Pages scanned" value={String(insights.scans.pagesScanned)} />
                  <Row label="Last duration" value={formatDuration(insights.scans.lastDurationMs)} />
                  <Row
                    label="Model"
                    value={
                      insights.scans.lastModel
                        ? `${insights.scans.lastModel}${insights.scans.lastFellBack ? " (fallback)" : ""}`
                        : "structural only"
                    }
                  />
                  {Object.entries(insights.scans.counts).map(([key, value]) => (
                    <Row key={key} label={countLabel(key)} value={String(value)} />
                  ))}
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Verification
                </h3>
                <dl className="divide-y divide-border">
                  <Row label="Checks run" value={String(insights.verification.total)} />
                  <Row
                    label="Last outcome"
                    value={
                      insights.verification.lastStatus
                        ? (OUTCOME_LABELS[insights.verification.lastStatus] ??
                          insights.verification.lastStatus)
                        : "—"
                    }
                  />
                  <Row
                    label="Last checked"
                    value={
                      insights.verification.lastCheckedAt
                        ? new Date(insights.verification.lastCheckedAt).toLocaleString()
                        : "—"
                    }
                  />
                  <Row label="Runtime" value={insights.verification.runtimeVersion ?? "—"} />
                  <Row
                    label="WebMCP in that browser"
                    value={insights.verification.webmcpAvailable ? "available" : "unavailable"}
                  />
                  <Row label="Site's own tools" value={String(insights.verification.nativeToolCount)} />
                  <Row label="Name conflicts" value={String(insights.verification.conflictCount)} />
                  <Row label="Added by Forge" value={String(insights.verification.forgeAddedCount)} />
                  {Object.entries(insights.verification.liveCounts).map(([key, value]) => (
                    <Row key={key} label={`${countLabel(key)} on live site`} value={String(value)} />
                  ))}
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Assistant
                </h3>
                <dl className="divide-y divide-border">
                  <Row label="Questions used" value={String(insights.ai.questionsUsed)} />
                  <Row label="Remaining (lifetime)" value={String(insights.ai.questionsRemaining)} />
                  <Row label="Last model" value={insights.ai.lastModel ?? "—"} />
                  <Row label="Last latency" value={formatDuration(insights.ai.lastLatencyMs)} />
                </dl>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Contact
                </h3>
                <dl className="divide-y divide-border">
                  <Row
                    label="Form detected"
                    value={insights.contact.formDetected ? "yes" : "no"}
                  />
                  <Row
                    label="Support"
                    value={
                      insights.contact.support
                        ? (SUPPORT_LABELS[insights.contact.support] ?? insights.contact.support)
                        : "—"
                    }
                  />
                  <Row
                    label="Sending enabled"
                    value={insights.contact.sendEnabled ? "yes" : "no"}
                  />
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  <Badge variant="outline" className="mr-1">
                    Private
                  </Badge>
                  Your own activity only. No visitor tracking, and ordinary agent tool calls on
                  your site are never reported here.
                </p>
              </section>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
