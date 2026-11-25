"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { layoutTransition } from "@/lib/motion";

export interface PillOption<V extends string> { value: V; label: ReactNode; icon?: ReactNode; count?: number; disabled?: boolean }

/**
 * Horizontally scrolling pill filter (menu categories, order filters). The active pill is filled copper and the fill
 * glides between pills (shared layout). Radiogroup semantics + arrow keys / Home / End; 44px tall touch targets.
 * When the row overflows, the clipped side fades out and shows a 44px arrow button that scrolls by most of a row,
 * so a half-cut pill always comes with a cue (UI_REVIEW BA-1). The arrows are pointer / touch helpers only: keyboard
 * users move with the arrow keys, which scroll the chosen pill into view.
 *   <PillTabs label="Category" value={cat} onChange={setCat}
 *     options={[{ value: "all", label: "All" }, { value: id, label: "Drinks", icon: <FoodGlyph kind="drink" /> }]} />
 */
export function PillTabs<V extends string>({ options, value, onChange, label, className, size = "md" }: {
  options: PillOption<V>[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function go(idx: number) {
    const o = options[idx]; if (!o || o.disabled) return;
    onChange(o.value); const el = refs.current[idx]; el?.focus(); el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
  function onKey(e: KeyboardEvent, idx: number) {
    const n = options.length;
    if (e.key === "Home") { e.preventDefault(); go(0); return; }
    if (e.key === "End") { e.preventDefault(); go(n - 1); return; }
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let k = 1; k <= n; k++) { const j = (idx + dir * k + n * k) % n; if (!options[j].disabled) { go(j); return; } }
  }
  const row = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = row.current; if (!el) return;
    const left = el.scrollLeft > 2, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useEffect(() => {
    const el = row.current; if (!el) return;
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el); for (const c of Array.from(el.children)) ro?.observe(c);
    return () => ro?.disconnect();
  }, [measure, options.length]);
  const nudge = (dir: 1 | -1) => { const el = row.current; if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" }); };
  const mask = edge.left && edge.right ? "pill-fade-both" : edge.left ? "pill-fade-left" : edge.right ? "pill-fade-right" : undefined;
  const arrow = "absolute top-1/2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface text-fg shadow-card transition-colors hover:bg-surface-2 [&_svg]:size-5";
  return (
    <div className={cn("relative min-w-0", className)} data-overflow={edge.left || edge.right ? "" : undefined}>
    {edge.left && <button type="button" tabIndex={-1} aria-hidden data-testid="pill-scroll-left" onClick={() => nudge(-1)} className={cn(arrow, "left-0")}><ChevronLeft /></button>}
    <div ref={row} role="radiogroup" aria-label={label} onScroll={measure} className={cn("-mx-1 flex gap-2 overflow-x-auto px-1 py-1 scrollbar-none [contain:inline-size]", mask)}>
      {options.map((o, idx) => {
        const on = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[idx] = el; }} type="button" role="radio" aria-checked={on}
            tabIndex={on ? 0 : -1} disabled={o.disabled} onClick={() => go(idx)} onKeyDown={(e) => onKey(e, idx)}
            className={cn(
              "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full font-semibold transition-[color,border-color,box-shadow] duration-150 disabled:opacity-50 [&_svg]:size-4",
              size === "sm" ? "h-11 pointer-fine:h-9 px-3.5 text-[0.8rem]" : "h-11 px-4 text-sm",
              on ? "border border-transparent text-primary-fg" : "border border-border bg-surface text-fg-muted shadow-xs hover:border-border-strong hover:text-fg",
            )}>
            {on && <motion.span layoutId={`pill-${id}`} transition={layoutTransition} className="absolute inset-0 rounded-full bg-primary bg-primary-gradient shadow-[var(--shadow-inset-hi),var(--shadow-glow)]" />}
            <span className="relative z-10 inline-flex items-center gap-2">
              {o.icon}{o.label}
              {o.count != null && <span className={cn("tnum rounded-full px-1.5 text-[0.7rem] leading-5", on ? "bg-white/20" : "bg-surface-2 text-fg-subtle")}>{o.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
    {edge.right && <button type="button" tabIndex={-1} aria-hidden data-testid="pill-scroll-right" onClick={() => nudge(1)} className={cn(arrow, "right-0")}><ChevronRight /></button>}
    </div>
  );
}
