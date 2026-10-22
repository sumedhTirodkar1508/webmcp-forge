"use client";

import { useEffect } from "react";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Fallback for anything the page couldn't render.
 *
 * Database outages are handled on the page itself with a specific message;
 * this covers everything else. In production Next.js hides the underlying
 * message from the browser, so this says nothing more specific than it knows.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning">
        <TriangleAlertIcon aria-hidden className="size-6" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        This page didn&apos;t load properly
      </h1>
      <p className="text-pretty text-sm text-muted-foreground">
        Something went wrong on our side. Your progress is saved — trying again usually fixes it.
      </p>
      <Button type="button" onClick={() => retry()}>
        <RotateCwIcon />
        Try again
      </Button>
      {error.digest && (
        <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
      )}
    </main>
  );
}
