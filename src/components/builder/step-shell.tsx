import type { ReactNode } from "react";
import { CheckIcon, LockIcon } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StepStatus = "locked" | "active" | "done";

interface StepShellProps {
  step: number;
  /** Anchor id, so the progress stepper can link straight to this step. */
  id?: string;
  title: string;
  subtitle: string;
  status: StepStatus;
  /**
   * True when this is the step the owner should do next (from
   * `stepStateFor`). It gets the visual emphasis, so a long page always has
   * one obvious place to look.
   */
  current?: boolean;
  /** Shown in place of children when `status` is "locked". */
  lockedHint?: string;
  /** True while this section is the one an agent (or button) just changed. */
  highlighted?: boolean;
  children: ReactNode;
}

/**
 * The numbered-step wrapper every builder section renders inside.
 *
 * Keeping this presentational (no `useBuilder()` of its own) means each
 * section decides for itself what "locked"/"active"/"done" and "highlighted"
 * mean for its own data, and this component only renders the result.
 */
export function StepShell({
  step,
  id,
  title,
  subtitle,
  status,
  current = false,
  lockedHint,
  highlighted = false,
  children,
}: StepShellProps) {
  const locked = status === "locked";
  const done = status === "done";
  const emphasised = current && !locked;

  return (
    <Card
      id={id}
      className={cn(
        // `scroll-mt` keeps the heading clear of the sticky progress bar when
        // a step is reached by its anchor link.
        "scroll-mt-20 transition-[box-shadow,opacity] duration-500 ease-out",
        emphasised && "shadow-lg ring-2 ring-brand/40 dark:ring-brand/50",
        // A just-changed section flashes neutral, over any emphasis.
        highlighted && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        locked && "bg-card/50 shadow-none ring-foreground/5",
      )}
      aria-disabled={locked || undefined}
      aria-current={emphasised ? "step" : undefined}
    >
      <CardHeader className="flex flex-row items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
            done || emphasised
              ? "bg-brand text-brand-foreground"
              : "border border-border bg-muted text-muted-foreground",
          )}
        >
          {done ? (
            <CheckIcon aria-hidden className="size-4" strokeWidth={2.5} />
          ) : locked ? (
            <LockIcon aria-hidden className="size-3.5" />
          ) : (
            step
          )}
          <span className="sr-only">
            Step {step}
            {done ? ", done" : locked ? ", not available yet" : ""}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2
              className={cn(
                "font-heading text-base font-semibold tracking-tight",
                locked ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {title}
            </h2>
            {emphasised && !done && (
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                Up next
              </span>
            )}
            {done && (
              <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                Done
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </CardHeader>
      <CardContent>
        {locked ? (
          <p className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
            {lockedHint}
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
