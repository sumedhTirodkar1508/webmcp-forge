"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CircleIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useBuilder } from "@/components/builder/builder-provider";
import { isVerified, stepStateFor } from "@/components/builder/progress";
import { RepairPanel } from "@/components/builder/repair-panel";
import { SectionError } from "@/components/builder/section-error";
import { StepShell } from "@/components/builder/step-shell";
import type { VerificationDiagnostic, VerificationState } from "@/lib/services/types";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const STATUS_ICON: Record<VerificationDiagnostic["status"], ReactNode> = {
  pass: <CheckCircle2Icon className="size-4 text-success" />,
  warn: <AlertTriangleIcon className="size-4 text-warning" />,
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
  const { state } = useBuilder();
  return <VerificationPanel key={state.siteId ?? "empty"} />;
}

function VerificationPanel() {
  const { state, actions, lastChanged } = useBuilder();

  const verification = state.verification;

  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [starting, setStarting] = useState(false);
  // Kept so the owner can open the check themselves: the tab is opened with
  // `noopener`, so `window.open` returns null either way and a popup blocker
  // can't be detected — the link is the fallback.
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const attemptRef = useRef(0);
  const inFlightRef = useRef(false);
  useEffect(() => () => { attemptRef.current += 1; }, []);

  async function handleCheck() {
    // Pin the site for the whole check. A verification belongs to one site and
    // one origin; if the target changes mid-check, this loop must stop rather
    // than keep refreshing (and re-rendering) whatever is now selected.
    const siteId = state.siteId;
    if (!siteId || inFlightRef.current) return;
    inFlightRef.current = true;
    const attempt = ++attemptRef.current;
    const isCurrent = () => attempt === attemptRef.current && actions.getState().siteId === siteId;
    setTimedOut(false);
    setStarting(true);
    const previousCheckedAt = verification?.checkedAt ?? null;

    let url: string;
    try {
      const result = await actions.startVerification(siteId);
      url = result.verifyUrl;
    } catch {
      if (isCurrent()) {
        setStarting(false);
        inFlightRef.current = false;
      }
      return;
    }
    if (!isCurrent()) return;
    setStarting(false);
    setVerifyUrl(url);

    window.open(url, "_blank", "noopener,noreferrer");

    setPolling(true);
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (isCurrent() && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (!isCurrent()) return;

      try {
        const next = await actions.refreshState(siteId);
        if (!isCurrent()) return;
        const nextVerification = next.verification;
        if (nextVerification?.checkedAt && nextVerification.checkedAt !== previousCheckedAt) {
          setPolling(false);
          inFlightRef.current = false;
          return;
        }
      } catch {
        // Transient network error — keep polling until the deadline.
      }
    }

    if (isCurrent()) {
      inFlightRef.current = false;
      setPolling(false);
      setTimedOut(true);
    }
  }

  function handleCancel() {
    attemptRef.current += 1;
    inFlightRef.current = false;
    setPolling(false);
  }

  return (
    <StepShell
      step={4}
      id="step-verify"
      title="Check it's live"
      subtitle="We open your site in a new tab and wait for the snippet to report back."
      // Done only on a passing check. A failed check is information, not
      // completion — this used to tick as soon as any result existed.
      status={!state.installation ? "locked" : isVerified(state) ? "done" : "active"}
      current={stepStateFor(state, "verify") === "current"}
      lockedHint="Generate your snippet first, then publish it on your site."
      highlighted={lastChanged === "verify"}
    >
      <div className="flex flex-col gap-4">
        <SectionError sections={["verify"]} />
        {verification && verification.status !== "not_started" && (
          <Verdict verification={verification} />
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            size="lg"
            variant={isVerified(state) ? "outline" : "default"}
            onClick={() => void handleCheck()}
            disabled={polling || starting}
          >
            {(polling || starting) && <Loader2Icon className="animate-spin" />}
            {polling ? "Waiting for your site…" : verification ? "Check again" : "Check installation"}
          </Button>
          {polling && (
            <Button type="button" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          )}
        </div>

        <p aria-live="polite" className="text-xs text-muted-foreground empty:hidden">
          {polling ? "Waiting for your site to report back. Keep the new tab open for a few seconds." : ""}
        </p>
        {polling && verifyUrl && (
          <p className="-mt-2 text-xs text-muted-foreground">
            No new tab?{" "}
            <a
              href={verifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-3"
            >
              Open your site to run the check
              <ArrowUpRightIcon aria-hidden className="size-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </p>
        )}

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
            {verification.diagnostics.length > 0 && (
              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {verification.diagnostics.map((diagnostic) => (
                  <li key={diagnostic.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                    <span className="mt-0.5 shrink-0">{STATUS_ICON[diagnostic.status]}</span>
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm text-foreground">{diagnostic.label}</span>
                      {diagnostic.detail && (
                        <span className="text-xs text-muted-foreground">{diagnostic.detail}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

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
                            void actions.scan().catch(() => {});
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

const VERDICT: Record<
  Exclude<VerificationState["status"], "not_started">,
  { title: string; body: string; tone: "success" | "warning" | "fail" | "neutral" }
> = {
  success: {
    title: "Your site is agent-ready",
    body: "The snippet is running on your site and every check passed.",
    tone: "success",
  },
  partial: {
    title: "Working, with a few gaps",
    body: "The snippet is running, but some checks need attention. The list below says which.",
    tone: "warning",
  },
  failed: {
    title: "Some checks failed",
    body: "Your site reported back, but not everything is working yet. The list below says what to fix.",
    tone: "fail",
  },
  pending: {
    title: "Check in progress",
    body: "Waiting for your site to report back.",
    tone: "neutral",
  },
};

/** The one-line answer to "did it work?", above the itemised diagnostics. */
function Verdict({ verification }: { verification: VerificationState }) {
  if (verification.status === "not_started") return null;
  const verdict = VERDICT[verification.status];
  const Icon =
    verdict.tone === "success"
      ? CheckCircle2Icon
      : verdict.tone === "fail"
        ? XCircleIcon
        : verdict.tone === "warning"
          ? AlertTriangleIcon
          : Loader2Icon;

  return (
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-2xl border px-4 py-3.5",
        verdict.tone === "success" && "border-success/25 bg-success-soft",
        verdict.tone === "warning" && "border-warning/25 bg-warning-soft",
        verdict.tone === "fail" && "border-destructive/25 bg-destructive/5",
        verdict.tone === "neutral" && "border-border bg-muted/40",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-5 shrink-0",
          verdict.tone === "success" && "text-success",
          verdict.tone === "warning" && "text-warning",
          verdict.tone === "fail" && "text-destructive",
          verdict.tone === "neutral" && "animate-spin text-muted-foreground motion-reduce:animate-none",
        )}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-semibold text-foreground">{verdict.title}</p>
        <p className="text-sm text-muted-foreground">{verdict.body}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {verification.toolsRegistered} {verification.toolsRegistered === 1 ? "tool" : "tools"}{" "}
          registered
          {verification.configVersion !== null && ` · version ${verification.configVersion}`}
          {verification.checkedAt && (
            // Relative time can differ by a minute between server and client.
            <span suppressHydrationWarning> · checked {formatWhen(verification.checkedAt)}</span>
          )}
        </p>
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0 || Number.isNaN(seconds)) return new Date(iso).toLocaleString();
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
