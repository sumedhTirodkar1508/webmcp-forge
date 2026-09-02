"use client";

import { InfoIcon, RadioIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useBuilder } from "@/components/builder/builder-provider";

/**
 * Always-visible panel showing whether this page can currently be driven by a
 * WebMCP agent, and — when it can — which tools are registered.
 */
export function AgentStatus() {
  const { webmcp, registeredTools } = useBuilder();

  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-card-foreground">
      {webmcp.available ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <RadioIcon className="size-3" />
              live
            </Badge>
            <span>
              This page is agent-ready — {registeredTools.length} builder{" "}
              {registeredTools.length === 1 ? "tool" : "tools"} registered.
            </span>
          </div>
          {registeredTools.length > 0 && (
            <Accordion>
              <AccordionItem value="tools">
                <AccordionTrigger className="text-xs">Registered tools</AccordionTrigger>
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
        </div>
      ) : (
        <Alert>
          <InfoIcon />
          <AlertDescription>{webmcp.message ?? "WebMCP is not available in this browser."}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        This is a live demo: a WebMCP-capable agent can drive this builder by calling the tools
        above instead of clicking buttons, and the page updates as it does.
      </p>
    </section>
  );
}
