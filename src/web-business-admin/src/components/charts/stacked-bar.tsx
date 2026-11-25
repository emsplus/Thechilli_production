"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export interface SegmentDatum { key: string; label: string; value: number; valueText: ReactNode; sub?: ReactNode; color: string }

/** One horizontal 100% stacked bar (2px surface gaps) + a legend that carries the exact numbers. */
export function StackedBar({ data, ariaLabel }: { data: SegmentDatum[]; ariaLabel: string }) {
  const reduce = useReducedMotion();
  const total = data.reduce((s, d) => s + d.value, 0);
  const shown = data.filter((d) => d.value > 0);
  return (
    <div>
      <div role="img" aria-label={`${ariaLabel}: ${data.map((d) => `${d.label} ${total ? Math.round((d.value / total) * 100) : 0}%`).join(", ")}`}
        className="flex h-8 w-full gap-0.5 overflow-hidden rounded-lg bg-surface-2">
        {shown.map((d, i) => (
          <motion.div key={d.key} className="h-full first:rounded-l-lg last:rounded-r-lg" title={`${d.label} ${Math.round((d.value / total) * 100)}%`}
            style={{ width: `${(d.value / total) * 100}%`, background: d.color, transformOrigin: "left" }}
            initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.45, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }} />
        ))}
      </div>
      <ul className="mt-4 grid gap-y-2.5">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-3 text-sm">
            <span aria-hidden className="size-3 shrink-0 rounded-[3px]" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate text-fg-muted"><span className="font-medium capitalize text-fg">{d.label}</span>{d.sub && <span className="ml-1.5 text-xs">{d.sub}</span>}</span>
            <span className="tnum text-xs text-fg-subtle">{total ? Math.round((d.value / total) * 100) : 0}%</span>
            <span className="tnum font-semibold text-fg">{d.valueText}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
