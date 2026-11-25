"use client";

import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";
import { compact, niceTicks, useWidth } from "./use-width";

export interface ColumnDatum {
  key: string;
  /** Short x-axis label (e.g. "12 Oct"). */
  label: string;
  value: number;
  /** Tooltip heading and the screen-reader name of the column. */
  title: string;
  /** Tooltip rows, preformatted strings (money comes from the exact decimal strings). */
  rows: { label: string; value: ReactNode }[];
  /** Formatted value for the screen-reader table. */
  valueText: string;
}

const H = 240, PAD = { t: 12, r: 8, b: 28, l: 44 };

/**
 * Single-series column chart: recessive hairline grid, 4px rounded data-end, grow-in animation,
 * hover/focus tooltip and a visually hidden data table for screen readers.
 */
export function ColumnChart({ data, ariaLabel, seriesName, className }: { data: ColumnDatum[]; ariaLabel: string; seriesName: string; className?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const vals = data.map((d) => d.value);
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const innerW = Math.max(0, w - PAD.l - PAD.r), innerH = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const band = data.length ? innerW / data.length : 0;
  const bw = Math.min(28, Math.max(3, band - 4));
  const labelEvery = Math.max(1, Math.ceil(44 / (band || 1)));
  const base = y(0);

  const tip = active != null ? data[active] : null;
  const tipX = active != null ? PAD.l + band * active + band / 2 : 0;
  const tipLeft = Math.min(Math.max(tipX, 90), Math.max(90, w - 90));

  return (
    <div ref={ref} className={cn("relative w-full", className)} onMouseLeave={() => setActive(null)}>
      {w > 0 && (
        <svg width={w} height={H} role="group" aria-label={ariaLabel} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={PAD.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="tnum fill-fg-subtle text-[11px]">{compact(t)}</text>
            </g>
          ))}
          <line x1={PAD.l} x2={w - PAD.r} y1={base} y2={base} stroke="var(--border-strong)" strokeWidth={1} />
          {data.map((d, i) => {
            const cx = PAD.l + band * i + band / 2;
            const x = cx - bw / 2;
            const yv = y(d.value);
            const top = Math.min(yv, base), h = Math.max(Math.abs(base - yv), d.value === 0 ? 0 : 1);
            const r = Math.min(4, bw / 2, h);
            const pos = d.value >= 0;
            // rounded on the data end, square at the baseline
            const path = pos
              ? `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${top + h}Z`
              : `M${x},${top}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + bw - r}Q${x + bw},${top + h} ${x + bw},${top + h - r}V${top}Z`;
            return (
              <g key={d.key}>
                {h > 0 && (
                  <motion.path d={path} fill={active === i ? "var(--primary-hover)" : "var(--viz-seq)"}
                    style={{ transformBox: "fill-box", transformOrigin: pos ? "50% 100%" : "50% 0%" }}
                    initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: 1 }}
                    transition={{ duration: 0.45, delay: Math.min(i * 0.015, 0.3), ease: [0.22, 1, 0.36, 1] }} />
                )}
                {i % labelEvery === 0 && <text x={cx} y={H - 8} textAnchor="middle" className="fill-fg-subtle text-[11px]">{d.label}</text>}
                <rect x={PAD.l + band * i} y={PAD.t} width={band} height={innerH + 4} fill="transparent" tabIndex={0} role="img" aria-label={`${d.title}: ${d.valueText}`}
                  className="cursor-default outline-none focus-visible:stroke-ring" strokeWidth={2} rx={4}
                  onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive((a) => (a === i ? null : a))}
                  onKeyDown={(e) => { if (e.key === "Escape") setActive(null); }} />
              </g>
            );
          })}
        </svg>
      )}
      {tip && (
        <div role="tooltip" className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 rounded-lg border border-border bg-surface p-2.5 text-xs shadow-pop"
          style={{ left: tipLeft, top: Math.max(0, Math.min(y(tip.value), base) - 8), transform: "translate(-50%, -100%)" }}>
          <p className="mb-1 font-semibold text-fg">{tip.title}</p>
          <dl className="space-y-0.5">
            {tip.rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3"><dt className="text-fg-muted">{r.label}</dt><dd className="tnum font-medium text-fg">{r.value}</dd></div>
            ))}
          </dl>
        </div>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">{seriesName}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.key}><th scope="row">{d.title}</th><td>{d.valueText}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
