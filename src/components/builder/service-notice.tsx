"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { CloudOffIcon, Loader2Icon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Shown when the page loaded without its data because the database could not
 * be reached. Reloading the server data is the whole fix, so that is the one
 * action offered.
 */
export function ServiceNotice({ message }: { message: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-2xl border border-warning/25 bg-warning-soft px-4 py-3.5 text-sm sm:flex-row sm:items-center"
    >
      <CloudOffIcon aria-hidden className="size-5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium text-foreground">Your saved progress couldn&apos;t load</p>
        <p className="text-muted-foreground">{message}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start sm:self-center"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
        Try again
      </Button>
    </div>
  );
}
