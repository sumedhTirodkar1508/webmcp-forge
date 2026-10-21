"use client";

import { CheckIcon } from "lucide-react";

import { useBuilder } from "@/components/builder/builder-provider";
import { deriveProgress } from "@/components/builder/progress";
import { cn } from "@/lib/utils";

/**
 * A compact, sticky "you are here" for a long page.
 *
 * The builder is six stacked cards; without this, an owner scrolled down to
 * "Verify" has no way to see what is still left, or to jump back. Each step
 * links to its section, and progress is derived from server state — the same
 * rules that drive each step's own checkmark — so the two can never disagree.
 */
export function ProgressStepper() {
  const { state } = useBuilder();
  const steps = deriveProgress(state);

  return (
    <nav
      aria-label="Setup progress"
      className="sticky top-0 z-20 -mx-4 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:-mx-6 sm:px-6"
    >
      <ol className="mx-auto flex max-w-3xl items-center gap-1 sm:gap-2">
        {steps.map((step, index) => (
          <li key={step.key} className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
            <a
              href={`#${step.anchor}`}
              aria-label={`${step.label}${step.optional ? " (optional)" : ""}${step.state === "done" ? " (completed)" : ""}`}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-1 text-xs transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                step.state === "current" && "font-medium text-foreground",
                step.state === "done" && "text-foreground",
                step.state === "upcoming" && "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium",
                  step.state === "done" && "border-transparent bg-brand text-brand-foreground",
                  step.state === "current" &&
                    "border-brand text-brand ring-3 ring-brand/15",
                  step.state === "upcoming" && "border-border text-muted-foreground",
                )}
              >
                {step.state === "done" ? (
                  <CheckIcon className="size-3" strokeWidth={3} />
                ) : (
                  index + 1
                )}
              </span>
              {/* Labels collapse on very narrow screens; the number still links. */}
              <span className="hidden truncate min-[420px]:inline">
                {step.label}
                {step.optional && <span className="text-muted-foreground"> · optional</span>}
              </span>
              <span className="sr-only">
                {step.state === "done"
                  ? " (completed)"
                  : step.state === "current"
                    ? " (current step)"
                    : ""}
              </span>
            </a>
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-2 flex-1",
                  step.state === "done" ? "bg-brand/60" : "bg-border",
                )}
              />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
