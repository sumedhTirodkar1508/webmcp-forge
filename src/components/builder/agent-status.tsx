"use client";

import { InfoIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { useBuilder } from "@/components/builder/builder-provider";
import type { WebMcpUnavailableReason } from "@/lib/webmcp/client";

/**
 * Whether this page can be driven by a WebMCP agent right now.
 *
 * This is the "use WebMCP to build WebMCP" signature, so it stays visible —
 * but it used to be the first thing on the page and, in most browsers, it led
 * with "This browser does not expose document.modelContext yet". That is an
 * engineering detail presented as a warning to someone who has done nothing
 * wrong. It is now a quiet one-liner, with the reason available on request in
 * plain language.
 */

const WHY_UNAVAILABLE: Record<WebMcpUnavailableReason, string> = {
  not_implemented:
    "Your browser doesn't support WebMCP yet. That's completely fine — everything here works with ordinary clicks, and your visitors' agents will still be able to use your site once it's set up.",
  insecure_context:
    "WebMCP only runs on secure (https) pages, so agents can't operate the builder from this address.",
  not_a_browser: "Agent control isn't available in this environment.",
};

export function AgentStatus() {
  const { webmcp, registeredTools } = useBuilder();

  if (webmcp.available) {
    return (
      <section
        aria-label="Agent control"
        className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative flex size-2.5" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          <span className="text-foreground">
            An AI agent in this browser can run this builder for you
          </span>
          <Badge variant="secondary">
            {registeredTools.length} {registeredTools.length === 1 ? "tool" : "tools"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Ask it to scan your site, change what agents may do, or generate your snippet — the page
          updates as it works.
        </p>
        {registeredTools.length > 0 && (
          <Accordion>
            <AccordionItem value="tools">
              <AccordionTrigger className="text-xs">Tools this page offers to agents</AccordionTrigger>
              <AccordionContent>
                <ul className="flex flex-wrap gap-1.5">
                  {registeredTools.map((name) => (
                    <li key={name}>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {name}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </section>
    );
  }

  const why = webmcp.reason ? WHY_UNAVAILABLE[webmcp.reason] : undefined;

  return (
    <details className="group rounded-2xl border border-dashed border-border px-4 py-2.5 text-xs text-muted-foreground [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <InfoIcon aria-hidden className="size-3.5 shrink-0" />
        <span>
          In a WebMCP-enabled browser, an AI agent can operate this builder for you.
        </span>
        <span className="ml-auto shrink-0 underline-offset-2 group-open:hidden hover:underline">
          Why not here?
        </span>
      </summary>
      {why && <p className="mt-2 pl-5.5 leading-relaxed">{why}</p>}
    </details>
  );
}
