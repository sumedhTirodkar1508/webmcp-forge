"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2Icon, XIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBuilder } from "@/components/builder/builder-provider";
import { StepShell } from "@/components/builder/step-shell";

/**
 * Step 1 — the portfolio address, and the button that kicks off a scan.
 */
export function TargetSection() {
  const { state, phase, error, actions, dismissError, lastChanged } = useBuilder();

  // Controlled input that starts from `state.targetUrl` and re-syncs whenever
  // it changes *externally* (e.g. a WebMCP `set_target_url` call) — but never
  // clobbers text the person is still typing. `lastSynced` tracks the value we
  // last pulled from context, so a change to `state.targetUrl` that already
  // matches it (i.e. it changed because of what we typed) is not a re-sync.
  const [value, setValue] = useState(state.targetUrl ?? "");
  const lastSynced = useRef(state.targetUrl ?? "");
  const submitInFlight = useRef(false);

  useEffect(() => {
    const incoming = state.targetUrl ?? "";
    if (incoming !== lastSynced.current) {
      lastSynced.current = incoming;
      setValue(incoming);
    }
  }, [state.targetUrl]);

  const busy = phase === "targeting" || phase === "scanning";
  const scanning = phase === "scanning";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitInFlight.current) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    submitInFlight.current = true;
    try {
      await actions.setTargetUrl(trimmed);
      await actions.scan();
    } catch {
      // The error is already surfaced through `error` in context.
    } finally {
      submitInFlight.current = false;
    }
  }

  return (
    <StepShell
      step={1}
      title="Point us at your site"
      subtitle="We'll fetch it and work out what an agent could do with it."
      status={state.discovery ? "done" : "active"}
      highlighted={lastChanged === "target"}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="target-url">Portfolio URL</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="target-url"
              type="url"
              inputMode="url"
              placeholder="https://your-portfolio.com"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              required
              className="break-all"
            />
            <Button type="submit" disabled={busy || value.trim().length === 0} className="shrink-0">
              {scanning ? <Loader2Icon className="animate-spin" /> : null}
              {scanning ? "Scanning your site…" : busy ? "Working…" : "Scan site"}
            </Button>
          </div>
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {scanning ? "Scanning your site… this can take a moment." : ""}
        </p>
      </form>

      {error && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={dismissError}
              aria-label="Dismiss error"
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      )}
    </StepShell>
  );
}
