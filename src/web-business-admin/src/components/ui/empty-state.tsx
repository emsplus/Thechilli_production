import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Friendly empty / error / first-run state.
 * `illustration` takes a component from components/illustrations (or any node); `icon` is the lighter option.
 */
export function EmptyState({ illustration, icon, title, hint, action, className, compact }: {
  illustration?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14", className)}>
      {illustration ? <div className={compact ? "w-28" : "w-40"}>{illustration}</div>
        : icon ? <div className="grid size-16 place-items-center rounded-3xl bg-primary-soft text-primary-soft-fg shadow-[var(--shadow-inset-hi)] [&_svg]:size-7">{icon}</div> : null}
      <h3 className="font-display text-lg font-bold text-fg">{title}</h3>
      {hint && <p className="max-w-sm text-sm text-fg-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
