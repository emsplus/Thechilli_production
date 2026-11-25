import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * White card on the cream canvas: hairline border + soft warm shadow, 16px radius.
 * `interactive` lifts on hover (pointer devices) and presses on tap.
 */
export function Card({ className, interactive, padded = true, ...props }: ComponentProps<"div"> & { interactive?: boolean; padded?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface shadow-card",
        padded && "p-4 sm:p-5",
        interactive && "transition-[box-shadow,transform,border-color] duration-200 ease-[var(--ease-out)] hover:border-border-strong hover:shadow-pop active:scale-[0.99] [@media(hover:hover)]:hover:-translate-y-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h3 className="font-display text-base font-bold leading-tight text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
