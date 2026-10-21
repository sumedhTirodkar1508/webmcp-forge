"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBuilder } from "@/components/builder/builder-provider";
import { ScanResults } from "@/components/builder/discovery-section";
import { stepStateFor } from "@/components/builder/progress";
import { SectionError } from "@/components/builder/section-error";
import { StepShell } from "@/components/builder/step-shell";

/**
 * Step 1 — the portfolio address, the button that kicks off a scan, and what
 * the scan found.
 */
export function TargetSection({ demoUrl }: { demoUrl: string | null }) {
  const { state, phase, actions, lastChanged } = useBuilder();

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

  async function scan(url: string) {
    if (busy || submitInFlight.current) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    submitInFlight.current = true;
    try {
      // Hand the scan the site the target call actually resolved to. Reading
      // "the current site" here instead would race React's re-render and, when
      // the address points somewhere new, scan the previous site.
      const target = await actions.setTargetUrl(trimmed);
      if (target.siteId) await actions.scan(target.siteId);
    } catch {
      // The error is surfaced by <SectionError> below.
    } finally {
      submitInFlight.current = false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void scan(value);
  }

  function tryDemo() {
    if (!demoUrl) return;
    setValue(demoUrl);
    void scan(demoUrl);
  }

  const isRescan = Boolean(state.discovery) && value.trim() === (state.targetUrl ?? "");

  return (
    <StepShell
      step={1}
      id="step-scan"
      title="Scan your site"
      subtitle="Paste the address of your published portfolio. We only read public pages."
      status={state.discovery ? "done" : "active"}
      current={stepStateFor(state, "scan") === "current"}
      highlighted={lastChanged === "target" || lastChanged === "discovery"}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="target-url">Portfolio URL</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="target-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://your-portfolio.com"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              required
              aria-describedby="target-url-help"
              className="h-10 break-all"
            />
            <Button
              type="submit"
              size="lg"
              disabled={busy || value.trim().length === 0}
              className="shrink-0"
            >
              {scanning && <Loader2Icon className="animate-spin" aria-hidden />}
              {scanning ? "Scanning…" : busy ? "Checking address…" : isRescan ? "Scan again" : "Scan site"}
            </Button>
          </div>
          <p id="target-url-help" className="text-xs text-muted-foreground">
            Works with Framer, Wix, Webflow, Squarespace and hand-built sites.
          </p>
        </div>

        {scanning ? (
          <ScanProgress />
        ) : (
          demoUrl &&
          !state.discovery && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-2xl border border-dashed border-border px-3.5 py-3">
              <span className="text-sm text-muted-foreground">
                Don&apos;t have a site handy? See the whole flow on a sample portfolio.
              </span>
              <Button type="button" variant="outline" size="sm" onClick={tryDemo} disabled={busy}>
                <SparklesIcon aria-hidden className="text-brand" />
                Try the demo
              </Button>
            </div>
          )
        )}
      </form>

      <SectionError sections={["target", "discovery"]} />
      {!scanning && <ScanResults />}
    </StepShell>
  );
}

/**
 * Honest scan feedback.
 *
 * A scan reads several pages and then asks an AI model to interpret them, so
 * it can take half a minute. The old indicator was just a spinner on the
 * button. This shows real elapsed time and an honest expectation — it does not
 * invent progress stages it cannot observe.
 *
 * Mounted only while a scan runs, so its timer starts fresh each time.
 */
function ScanProgress() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hint =
    elapsed < 15
      ? "Reading your pages and working out what's on them. This usually takes 10–40 seconds."
      : elapsed < 45
        ? "Still working — larger sites and slow hosts take a little longer."
        : "Almost there. If your site is slow to respond we'll finish with what we've read so far.";

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-brand/20 bg-brand-soft px-3.5 py-3 text-xs text-muted-foreground">
      {/* Indeterminate on purpose: we can't observe how far along a scan is. */}
      <div aria-hidden className="h-1 overflow-hidden rounded-full bg-brand/15">
        <div className="h-full w-1/3 animate-[forge-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-brand motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
      </div>
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-foreground">
          Scanning your site
          {/* The ticking counter is visual only; announcing it every second
              would drown a screen reader. The hint below is what's announced. */}
          <span aria-hidden className="tabular-nums">
            {" "}
            · {elapsed}s
          </span>
        </span>
        <span role="status" aria-live="polite">
          {hint}
        </span>
      </span>
    </div>
  );
}
