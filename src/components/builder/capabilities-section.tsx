"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useBuilder } from "@/components/builder/builder-provider";
import { StepShell } from "@/components/builder/step-shell";
import { cn } from "@/lib/utils";

/**
 * Step 3 — one row per capability, each toggled independently.
 */
export function CapabilitiesSection() {
  const { state, actions, lastChanged } = useBuilder();
  const capabilities = state.capabilities;

  return (
    <StepShell
      step={3}
      title="Choose what agents can do"
      subtitle="Turn capabilities on or off — this never touches your site."
      status={
        capabilities.length === 0 ? "locked" : state.installation ? "done" : "active"
      }
      lockedHint="Scan your site to see available capabilities."
      highlighted={lastChanged?.startsWith("capability:") ?? false}
    >
      <p aria-live="polite" className="sr-only">
        {lastChanged?.startsWith("capability:")
          ? `${lastChanged.slice("capability:".length)} updated.`
          : ""}
      </p>
      <div className="flex flex-col divide-y divide-border">
        {capabilities.map((capability) => {
          const rowHighlighted = lastChanged === `capability:${capability.id}`;
          return (
            <div
              key={capability.id}
              className={cn(
                "flex items-start justify-between gap-4 py-3 transition-shadow duration-700 first:pt-0 last:pb-0",
                rowHighlighted && "ring-2 ring-ring ring-offset-2 ring-offset-background rounded-xl px-2",
              )}
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{capability.label}</span>
                  {!capability.readOnly && (
                    <Badge variant="outline" className="text-[10px]">
                      Changes what visitors see
                    </Badge>
                  )}
                </div>
                <p
                  id={`capability-desc-${capability.id}`}
                  className="text-sm text-muted-foreground"
                >
                  {capability.description}
                </p>
                {!capability.supported && (
                  <p className="text-xs text-muted-foreground">Not found on your site.</p>
                )}
              </div>
              <Switch
                checked={capability.enabled}
                disabled={!capability.supported}
                onCheckedChange={(next) => {
                  void actions.setCapabilityEnabled(capability.id, next);
                }}
                aria-label={`Toggle ${capability.label}`}
                aria-describedby={`capability-desc-${capability.id}`}
                className="mt-0.5 shrink-0"
              />
            </div>
          );
        })}
      </div>

      {capabilities.length > 0 && (
        <Accordion className="mt-4">
          <AccordionItem value="advanced">
            <AccordionTrigger className="text-xs">Advanced</AccordionTrigger>
            <AccordionContent>
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {capabilities.map((capability) => (
                  <li key={capability.id} className="flex flex-wrap gap-1.5 font-mono">
                    <span>{capability.id}</span>
                    <span>→</span>
                    <span>{capability.toolName}</span>
                  </li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
    </StepShell>
  );
}
