"use client";

import {
  ArrowDownIcon,
  BookOpenIcon,
  MailIcon,
  MousePointer2Icon,
  type LucideIcon,
} from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useBuilder } from "@/components/builder/builder-provider";
import { stepStateFor } from "@/components/builder/progress";
import { SectionError } from "@/components/builder/section-error";
import { StepShell } from "@/components/builder/step-shell";
import type { CapabilityId } from "@/lib/capabilities/catalogue";
import type { CapabilityState } from "@/lib/services/types";
import { cn } from "@/lib/utils";

/**
 * Step 3 — what agents may do, grouped by what each capability actually does.
 *
 * This was a flat wall of twelve switches, and every non-read-only one wore the
 * same "Changes what visitors see" badge — including "Draft a message", which
 * changes nothing, and "Send a message", whose real consequence is that a
 * message gets sent. Grouping by effect, and labelling each by its actual
 * effect, lets an owner scan the list and understand the risk of each choice.
 */

interface Group {
  key: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
  ids: readonly CapabilityId[];
}

const GROUPS: readonly Group[] = [
  {
    key: "read",
    title: "What agents can read",
    blurb: "Let agents answer visitors' questions using what's already on your site.",
    icon: BookOpenIcon,
    ids: [
      "get_profile",
      "list_projects",
      "get_project",
      "search_projects",
      "get_skills",
      "get_experience",
      "get_education",
      "get_contact_info",
    ],
  },
  {
    key: "act",
    title: "What agents can do on the page",
    blurb: "Let agents guide a visitor around your portfolio.",
    icon: MousePointer2Icon,
    ids: ["navigate_site", "focus_project"],
  },
  {
    key: "contact",
    title: "Contact",
    blurb:
      "Off unless you turn it on. A message is only ever sent after the visitor approves it in their own browser.",
    icon: MailIcon,
    ids: ["prepare_contact_message", "send_contact_message"],
  },
];

/** What a capability actually does, when that is worth calling out. */
const EFFECT_BADGE: Partial<Record<CapabilityId, { label: string; tone: "neutral" | "caution" }>> = {
  navigate_site: { label: "Moves the page", tone: "neutral" },
  focus_project: { label: "Scrolls the page", tone: "neutral" },
  prepare_contact_message: { label: "Nothing is sent", tone: "neutral" },
  send_contact_message: { label: "Sends a message · visitor confirms", tone: "caution" },
};

export function CapabilitiesSection() {
  const { state, actions, lastChanged, phase } = useBuilder();
  const capabilities = state.capabilities;
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  const enabledCount = capabilities.filter((capability) => capability.enabled).length;

  return (
    <StepShell
      step={2}
      id="step-choose"
      title="Choose what agents can do"
      subtitle="Turn capabilities on or off. Nothing on your site changes until you install."
      status={capabilities.length === 0 ? "locked" : state.installation ? "done" : "active"}
      current={stepStateFor(state, "choose") === "current"}
      lockedHint="Scan your site to see what agents could do with it."
      highlighted={lastChanged?.startsWith("capability:") ?? false}
    >
      <p aria-live="polite" className="sr-only">
        {lastChanged?.startsWith("capability:")
          ? `${byId.get(lastChanged.slice("capability:".length) as CapabilityId)?.label ?? "Capability"} updated.`
          : ""}
      </p>

      {capabilities.length > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          {enabledCount} of {capabilities.length} turned on. Reading and navigation start on;
          contact stays off until you choose it.
        </p>
      )}

      <div className="flex flex-col gap-6">
        {GROUPS.map((group) => {
          const items = group.ids
            .map((id) => byId.get(id))
            .filter((capability): capability is CapabilityState => Boolean(capability));
          if (items.length === 0) return null;
          const on = items.filter((capability) => capability.enabled).length;

          return (
            <section key={group.key} aria-labelledby={`cap-group-${group.key}`}>
              <div className="mb-2 flex items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <group.icon aria-hidden className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <h3
                      id={`cap-group-${group.key}`}
                      className="text-sm font-medium text-foreground"
                    >
                      {group.title}
                    </h3>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
                        on > 0 ? "bg-muted text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {on} of {items.length} on
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{group.blurb}</p>
                </div>
              </div>

              <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
                {items.map((capability) => (
                  <CapabilityRow
                    key={capability.id}
                    capability={capability}
                    highlighted={lastChanged === `capability:${capability.id}`}
                    saving={phase === "saving"}
                    onToggle={(next) => void actions.setCapabilityEnabled(capability.id, next).catch(() => {})}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <SectionError sections={["capability:*"]} />

      {capabilities.length > 0 && !state.installation && (
        <a
          href="#step-install"
          className="mt-5 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Happy with these? Generate your snippet
          <ArrowDownIcon aria-hidden className="size-4" />
        </a>
      )}

      {capabilities.length > 0 && (
        <Accordion className="mt-4">
          <AccordionItem value="advanced">
            <AccordionTrigger className="text-xs">Tool names agents will see</AccordionTrigger>
            <AccordionContent>
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {capabilities.map((capability) => (
                  <li key={capability.id} className="flex flex-wrap gap-1.5">
                    <span className="font-mono text-foreground">{capability.toolName}</span>
                    <span aria-hidden>—</span>
                    <span>{capability.label}</span>
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

function CapabilityRow({
  capability,
  highlighted,
  saving,
  onToggle,
}: {
  capability: CapabilityState;
  highlighted: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}) {
  const badge = EFFECT_BADGE[capability.id];
  const descriptionId = `capability-desc-${capability.id}`;

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-4 px-3.5 py-3 transition-colors duration-500",
        capability.enabled && capability.supported && "bg-muted/25",
        highlighted && "bg-brand-soft",
        !capability.supported && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{capability.label}</span>
          {badge && (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                badge.tone === "caution" && "border-warning/40 bg-warning-soft text-warning",
              )}
            >
              {badge.label}
            </Badge>
          )}
        </div>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {capability.description}
        </p>
        {!capability.supported && (
          <p className="text-xs text-muted-foreground">
            We didn&apos;t find this on your site, so it&apos;s unavailable.
          </p>
        )}
      </div>
      <Switch
        checked={capability.enabled}
        // Disabled while any toggle is saving: two quick taps on different
        // switches would otherwise race and the second response could overwrite
        // the first.
        disabled={!capability.supported || saving}
        onCheckedChange={onToggle}
        aria-label={capability.label}
        aria-describedby={descriptionId}
        className="mt-0.5 shrink-0"
      />
    </li>
  );
}
