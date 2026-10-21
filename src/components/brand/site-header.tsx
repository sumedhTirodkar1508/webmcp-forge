import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";

import { ForgeMark } from "@/components/brand/forge-mark";

const WEBMCP_EXPLAINER_URL = "https://github.com/webmachinelearning/webmcp";

/** The product bar. Deliberately quiet: the builder below is the product. */
export function SiteHeader() {
  return (
    <header className="border-b border-border/70 bg-background">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg text-sm font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <ForgeMark />
          WebMCP Forge
        </Link>
        <a
          href={WEBMCP_EXPLAINER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          What is WebMCP?
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
    </header>
  );
}
