import { cn } from "@/lib/utils";

/**
 * The WebMCP Forge mark: a tool interface (angle brackets) around a spark.
 *
 * Kept in sync by hand with `src/app/icon.svg`, which is the same drawing as
 * a static file so the browser tab gets it without rendering React.
 */
export function ForgeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className={cn("size-7 shrink-0", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path
        d="M11 10.5 5.5 16l5.5 5.5M21 10.5l5.5 5.5-5.5 5.5"
        fill="none"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-brand-foreground"
      />
      <path
        d="M16 10.5l1.4 4.1 4.1 1.4-4.1 1.4-1.4 4.1-1.4-4.1-4.1-1.4 4.1-1.4z"
        className="fill-brand-foreground"
      />
    </svg>
  );
}
