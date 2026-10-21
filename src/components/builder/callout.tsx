import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

/**
 * A calm caution with a title: something the owner should know or act on, not
 * an error. Errors use <SectionError>.
 */
export function Callout({
  title,
  role,
  children,
}: {
  title: string;
  role?: "status";
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className="flex gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft px-3.5 py-3 text-sm"
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-medium text-foreground">{title}</p>
        <div className="mt-1 text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
