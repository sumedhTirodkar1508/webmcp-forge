"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useBuilder } from "@/components/builder/builder-provider";
import { RepairPanel } from "@/components/builder/repair-panel";
import { StepShell } from "@/components/builder/step-shell";
import type { VerificationDiagnostic } from "@/lib/services/types";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const STATUS_ICON: Record<VerificationDiagnostic["status"], ReactNode> = {
  pass: <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" />,
  warn: <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />,
  fail: <XCircleIcon className="size-4 text-destructive" />,
  unknown: <CircleIcon className="size-4 text-muted-foreground" />,
};

/**
 * Step 5 — kick off a live check, poll for the runtime's answer, then show
 * the diagnostics.
 *
 * The portfolio callback is an out-of-band event, so polling refreshes the
 * provider's shared server-authoritative state. That keeps this panel and the
 * builder's `get_verification_status` WebMCP tool in sync.
 */
export function VerifySection() {
  const { state, actions, lastChanged } = useBuilder();

  const verification = state.verification;

  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [starting, setStarting] = useState(false);
  const cancelledRef = useRef(false);

  async function handleCheck() {
    // Pin the site for the whole check. A verification belongs to one site and
    // one origin; if the target changes mid-check, this loop must stop rather
    // than keep refreshing (and re-rendering) whatever is now selected.
    const siteId = state.siteId;
    if (!siteId) return;
    setTimedOut(false);
    setStarting(true);
    const previousCheckedAt = verification?.checkedAt ?? null;

    let verifyUrl: string;
    try {
      const result = await actions.startVerification(siteId);
      verifyUrl = result.verifyUrl;
    } catch {
      setStarting(false);
      return;
    }
    setStarting(false);

    window.open(verifyUrl, "_blank", "noopener,noreferrer");

    cancelledRef.current = false;
    setPolling(true);
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (!cancelledRef.current && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (cancelledRef.current) return;

      // The user switched targets while this check was running. Abandon it —
      // site A's result must never be applied to site B's panel.
      if (actions.getState().siteId !== siteId) {
        setPolling(false);
        return;
      }

      try {
        const next = await actions.refreshState(siteId);
        const nextVerification = next.verification;
        if (nextVerification?.checkedAt && nextVerification.checkedAt !== previousCheckedAt) {
          setPolling(false);
          return;
        }
      } catch {
        // Transient network error — keep polling until the deadline.
      }
    }

    if (!cancelledRef.current) {
      setPolling(false);
      setTimedOut(true);
    }
  }

  function handleCancel() {
    cancelledRef.current = true;
    setPolling(false);
  }

  return (
    <StepShell
      step={5}
      title="Verify it's live"
      subtitle="Open your site in a new tab and confirm the runtime reports back."
      status={!state.installation ? "locked" : verification ? "done" : "active"}
      lockedHint="Generate your installation snippet first."
      highlighted={lastChanged === "verify"}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button type="button" onClick={() => void handleCheck()} disabled={polling || starting}>
            {(polling || starting) && <Loader2Icon className="animate-spin" />}
            Check installation
          </Button>
          {polling && (
            <Button type="button" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          )}
        </div>

        <p aria-live="polite" className="text-xs text-muted-foreground">
          {polling ? "Waiting for your site to report back…" : ""}
        </p>

        {timedOut && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Your site hasn&apos;t reported back yet</AlertTitle>
            <AlertDescription>
              This usually means one of: the snippet isn&apos;t installed yet, the site wasn&apos;t
              published after adding it, or the verification tab was blocked by a popup blocker.
              Double check the install steps above, allow popups for this page, then try again.
            </AlertDescription>
          </Alert>
        )}

        {verification && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {verification.diagnostics.map((diagnostic) => (
                <div key={diagnostic.id} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">{STATUS_ICON[diagnostic.status]}</span>
                  <div className="flex flex-col">
                    <span className="text-sm text-foreground">{diagnostic.label}</span>
                    {diagnostic.detail && (
                      <span className="text-xs text-muted-foreground">{diagnostic.detail}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {verification.changes.length > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/40 p-3">
                <span className="text-xs font-medium text-muted-foreground">
                  What changed since last check
                </span>
                {verification.changes.map((change) => {
                  if (change.kind === "broken") {
                    return (
                      <Alert key={change.key} variant="destructive">
                        <AlertTriangleIcon />
                        <AlertDescription>
                          <span className="font-medium">{change.key}</span>: the mapping no longer
                          matches your site. Re-scan to update it.
                        </AlertDescription>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => {
                            void actions.scan();
                          }}
                        >
                          Re-scan
                        </Button>
                      </Alert>
                    );
                  }
                  const diff = Math.abs(change.current - change.previous);
                  const word = change.kind === "grew" ? "more" : "fewer";
                  return (
                    <p key={change.key} className="text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">{change.key}</span>: {diff}{" "}
                      {word} than last time
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <RepairPanel />
    </StepShell>
  );
}
