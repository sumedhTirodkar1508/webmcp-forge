import { MousePointerClickIcon, ScanSearchIcon, SlidersHorizontalIcon } from "lucide-react";

/**
 * The first thing an owner sees.
 *
 * The audience is designers, not engineers: this explains the idea in plain
 * terms and shows the whole journey up front, so the steps below read as a
 * short path rather than an open-ended form.
 *
 * `compact` is for an owner returning to a site they've already scanned — they
 * have read the pitch, and the steps below are what they came back for.
 *
 * Static and server-rendered: nothing here depends on live builder state.
 */

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

export function ForgeHero({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex flex-col gap-1.5">
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
          Make your portfolio agent-ready
        </h1>
        <p className="text-pretty text-sm text-muted-foreground">
          Pick up where you left off — your progress is saved in this browser.
        </p>
      </div>
    );
  }

  return (
    <div className="relative isolate flex flex-col items-center gap-6 text-center">
      {/* A soft ember glow behind the headline; decorative only. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-64 w-[min(42rem,100%)] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl dark:bg-brand/15"
      />

      <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/20 bg-brand-soft px-3 py-1 text-xs font-medium text-brand">
        <span aria-hidden className="size-1.5 rounded-full bg-brand" />
        Built on WebMCP, the open standard for agent-ready websites
      </span>

      <div className="flex flex-col gap-4">
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Make your portfolio <span className="text-brand">agent-ready</span>
        </h1>
        <p className="mx-auto max-w-xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
          AI agents are starting to browse the web for people. WebMCP lets your site tell them
          exactly what it offers — your work, your skills, how to reach you — instead of leaving
          them to guess. Forge sets it up in a few minutes, no code required.
        </p>
      </div>

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
    </div>
  );
}
