"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface BarDatum { key: string; label: string; value: number; valueText: ReactNode; sub?: ReactNode }

/** Ranked horizontal bars with direct value labels. HTML-based so long names truncate and wrap safely. */
export function HorizontalBars({ data, ariaLabel, className }: { data: BarDatum[]; ariaLabel: string; className?: string }) {
  const reduce = useReducedMotion();
  const max = Math.max(0, ...data.map((d) => d.value)) || 1;
  return (
    <ol aria-label={ariaLabel} className={cn("space-y-3", className)}>
      {data.map((d, i) => (
        <li key={d.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="tnum text-xs font-medium text-fg-subtle">{i + 1}</span>
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-fg" title={d.label}>{d.label}</span>
              {d.sub && <span className="shrink-0 text-xs text-fg-subtle">{d.sub}</span>}
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-r-full" aria-hidden>
              <motion.div className="h-full rounded-r-[4px] bg-[var(--viz-seq)]" style={{ width: `${Math.max(1.5, (d.value / max) * 100)}%`, transformOrigin: "left" }}
                initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.45, delay: i * 0.03, ease: [0.22, 1, 0.36, 1] }} />
            </div>
          </div>
          <span className="tnum text-sm font-semibold text-fg">{d.valueText}</span>
        </li>
      ))}
    </ol>
  );
}
