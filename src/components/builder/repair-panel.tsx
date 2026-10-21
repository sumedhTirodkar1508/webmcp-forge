"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Wrench, XCircle } from "lucide-react";

import { useBuilder } from "@/components/builder/builder-provider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Mapping repair.
 *
 * Appears only when a verification check found a saved selector matching
 * nothing. It re-scans, shows what changed in plain language, and publishes
 * only when the owner explicitly says so — the currently published
 * configuration keeps serving until then.
 */

interface RepairChange {
  section: string;
  status: "recovered" | "unchanged" | "still_broken" | "removed" | "added";
  summary: string;
  previousSelector?: string;
  proposedSelector?: string;
  previousCount?: number;
  proposedCount?: number;
}

interface RepairPreview {
  applicable: boolean;
  changes: RepairChange[];
  warnings: string[];
  brokenSections: string[];
}

const STATUS_ICON: Record<RepairChange["status"], typeof CheckCircle2> = {
  recovered: CheckCircle2,
  added: CheckCircle2,
  unchanged: CheckCircle2,
  still_broken: XCircle,
  removed: XCircle,
};

export function RepairPanel() {
  const { state, actions } = useBuilder();
  /*
   * A proposal is stored WITH the site it was produced for.
   *
   * A repair publishes a new configuration, so applying one that was computed
   * for a different site would publish the wrong mapping. Tagging it means a
   * stale proposal stops being displayed — and stops being applicable — the
   * moment the target changes.
   */
  const [proposal, setProposal] = useState<{ siteId: string; preview: RepairPreview } | null>(
    null,
  );
  const [phase, setPhase] = useState<"idle" | "scanning" | "applying">("idle");
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const broken = (state.verification?.changes ?? []).filter((c) => c.kind === "broken");
  const hasBroken =
    broken.length > 0 ||
    Object.values(state.verification?.liveCounts ?? {}).some((count) => count === 0);

  if (!state.siteId || !hasBroken) return null;

  const call = async (action: "preview" | "apply") => {
    const siteId = state.siteId;
    if (!siteId) return;

    // Applying must use the site the proposal was actually computed for.
    if (action === "apply" && proposal?.siteId !== siteId) {
      setError("That repair proposal was for a different site. Re-scan to propose a new one.");
      return;
    }

    setError(null);
    setPhase(action === "preview" ? "scanning" : "applying");
    try {
      const response = await fetch("/api/builder/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteId, action }),
      });
      const body = (await response.json()) as {
        preview?: RepairPreview;
        error?: { message: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "The repair failed.");

      if (action === "preview") {
        setProposal(body.preview ? { siteId, preview: body.preview } : null);
      } else {
        setApplied(true);
        setProposal(null);
        // Refresh the site this repair belonged to, not "whatever is current".
        await actions.refreshState(siteId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The repair failed.");
    } finally {
      setPhase("idle");
    }
  };

  // Only ever render a proposal belonging to the site on screen.
  const preview = proposal?.siteId === state.siteId ? proposal.preview : null;

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start gap-2">
        <Wrench aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            Some saved mappings no longer match your site
          </p>
          <p className="text-sm text-muted-foreground">
            Your site has probably changed. We can re-scan and propose a fix — nothing is
            published until you approve it, and your site is never edited.
          </p>
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {phase === "scanning"
          ? "Re-scanning your site."
          : phase === "applying"
            ? "Publishing the repaired configuration."
            : applied
              ? "Repair published."
              : ""}
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {applied && (
        <Alert>
          <AlertDescription>
            Repair saved as a new configuration version. Copy the updated snippet above,
            publish it on your site, then check the installation again.
          </AlertDescription>
        </Alert>
      )}

      {preview && (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {preview.changes.map((change) => {
              const Icon = STATUS_ICON[change.status];
              const bad = change.status === "still_broken" || change.status === "removed";
              return (
                <li key={change.section} className="flex items-start gap-2 text-sm">
                  <Icon
                    aria-hidden
                    className={`mt-0.5 size-4 shrink-0 ${bad ? "text-destructive" : "text-success"}`}
                  />
                  <span className="text-foreground">{change.summary}</span>
                </li>
              );
            })}
          </ul>

          {preview.warnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {preview.warnings.map((warning) => (
                <li key={warning} className="text-xs text-muted-foreground">
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <Accordion>
            <AccordionItem value="repair-detail">
              <AccordionTrigger className="text-xs">Technical details</AccordionTrigger>
              <AccordionContent>
                <dl className="flex flex-col gap-2 text-xs">
                  {preview.changes.map((change) => (
                    <div key={change.section} className="flex flex-col gap-0.5">
                      <dt className="font-medium text-foreground">{change.section}</dt>
                      <dd className="break-all font-mono text-muted-foreground">
                        {change.previousSelector ?? "—"}
                        {change.proposedSelector && change.proposedSelector !== change.previousSelector
                          ? ` → ${change.proposedSelector}`
                          : ""}
                        {change.proposedCount !== undefined ? ` (${change.proposedCount} items)` : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={phase !== "idle"}
          onClick={() => void call("preview")}
        >
          {phase === "scanning" ? (
            <>
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Re-scanning…
            </>
          ) : (
            "Repair mappings"
          )}
        </Button>

        {preview && (
          <Button size="sm" disabled={!preview.applicable || phase !== "idle"} onClick={() => void call("apply")}>
            {phase === "applying" ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin" />
                Publishing…
              </>
            ) : (
              "Apply repair"
            )}
          </Button>
        )}

        {preview && !preview.applicable && (
          <Badge variant="outline" className="self-center">
            Nothing safe to apply
          </Badge>
        )}
      </div>
    </div>
  );
}
