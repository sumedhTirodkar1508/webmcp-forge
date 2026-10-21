import { EyeIcon, LockIcon, PenOffIcon } from "lucide-react";

/**
 * The promises an owner should be able to find without reading the code.
 * Each one is enforced in the product, not just stated here.
 */
const PROMISES = [
  { icon: EyeIcon, text: "We only read your public pages." },
  { icon: PenOffIcon, text: "Your site is never edited. You paste the snippet yourself." },
  { icon: LockIcon, text: "No visitor tracking. Messages are only sent when a visitor approves." },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <ul className="grid gap-2 sm:grid-cols-3">
          {PROMISES.map((promise) => (
            <li key={promise.text} className="flex items-start gap-2 text-xs text-muted-foreground">
              <promise.icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{promise.text}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground/80">
          WebMCP Forge · Built on the open WebMCP proposal.
        </p>
      </div>
    </footer>
  );
}
