"use client";

import { MousePointerClickIcon, ScanSearchIcon, SlidersHorizontalIcon } from "lucide-react";

import { useBuilder } from "@/components/builder/builder-provider";

const STEPS = [
  {
    icon: ScanSearchIcon,
    title: "Scan your site",
    body: "We read your public pages and find your projects, skills and contact details.",
  },
  {
    icon: SlidersHorizontalIcon,
    title: "Choose what agents can do",
    body: "Pick what agents may read or do. Nothing on your site changes yet.",
  },
  {
    icon: MousePointerClickIcon,
    title: "Paste one script tag",
    body: "Add it to your site's custom code, publish, and we'll confirm it works.",
  },
] as const;

/**
 * The three-step overview under the headline.
 *
 * It goes away once a site has been scanned, because from then on the progress
 * bar and the step cards below say the same thing with real state. It follows
 * the builder state rather than whether the page was freshly loaded: the hero
 * used to switch to a different, smaller layout only after a reload, so the
 * same session looked different depending on when you last refreshed.
 */
export function HowItWorks() {
  const { state } = useBuilder();

  if (state.discovery) {
    return (
      <p className="text-xs text-muted-foreground">
        Your progress is saved in this browser — pick up where you left off.
      </p>
    );
  }

  return (
    <ol className="grid w-full gap-3 text-left sm:grid-cols-3" aria-label="How it works">
      {STEPS.map((step, index) => (
        <li
          key={step.title}
          className="flex gap-3 rounded-2xl border border-border bg-card p-4 shadow-xs sm:flex-col sm:gap-3"
        >
          <span className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
              <step.icon aria-hidden className="size-4" />
            </span>
            <span
              aria-hidden
              className="hidden text-xs font-medium tabular-nums text-muted-foreground sm:inline"
            >
              0{index + 1}
            </span>
          </span>
          <span className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">
              <span className="sr-only">Step {index + 1}: </span>
              {step.title}
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
