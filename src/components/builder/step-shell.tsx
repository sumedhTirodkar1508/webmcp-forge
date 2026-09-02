import type { ReactNode } from "react";
import { CheckIcon, LockIcon } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StepStatus = "locked" | "active" | "done";

interface StepShellProps {
  step: number;
  title: string;
  subtitle: string;
  status: StepStatus;
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
  title,
  subtitle,
  status,
  lockedHint,
  highlighted = false,
  children,
}: StepShellProps) {
  const locked = status === "locked";

  return (
    <Card
      className={cn(
        "transition-shadow duration-700 ease-out",
        highlighted && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        locked && "opacity-60",
      )}
      aria-disabled={locked || undefined}
    >
      <CardHeader className="flex flex-row items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
            status === "done"
              ? "border-transparent bg-primary text-primary-foreground"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {status === "done" ? (
            <CheckIcon className="size-4" />
          ) : locked ? (
            <LockIcon className="size-3.5" />
          ) : (
            step
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </CardHeader>
      <CardContent>
        {locked ? (
          <p className="text-sm text-muted-foreground">{lockedHint}</p>
        ) : (
          <div className={locked ? "pointer-events-none select-none" : undefined}>{children}</div>
        )}
      </CardContent>
    </Card>
  );
}
