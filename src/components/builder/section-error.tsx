"use client";

import { XIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useBuilder } from "@/components/builder/builder-provider";

/**
 * Shows the builder's current error — but only in the section that caused it.
 *
 * `sections` lists the `run()` keys this section owns. A key ending in `*`
 * matches by prefix, so `capability:*` covers every capability toggle.
 */
export function SectionError({ sections }: { sections: readonly string[] }) {
  const { error, errorSection, dismissError } = useBuilder();

  if (!error || !errorSection) return null;

  const owns = sections.some((key) =>
    key.endsWith("*") ? errorSection.startsWith(key.slice(0, -1)) : errorSection === key,
  );
  if (!owns) return null;

  return (
    <Alert variant="destructive" className="mt-3" role="alert">
      <AlertDescription>{error}</AlertDescription>
      <AlertAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={dismissError}
          aria-label="Dismiss error"
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  );
}
