import { HowItWorks } from "@/components/builder/how-it-works";

/**
 * The first thing an owner sees.
 *
 * The audience is designers, not engineers: this explains the idea in plain
 * terms. The headline block is identical on every visit; only the step
 * overview beneath it (<HowItWorks>) gives way once there is progress to show.
 */
export function ForgeHero() {
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

      <HowItWorks />
    </div>
  );
}
