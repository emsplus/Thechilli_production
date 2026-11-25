"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { layoutTransition } from "@/lib/motion";

export interface SegmentOption<V extends string> { value: V; label: ReactNode; icon?: ReactNode; disabled?: boolean }

/**
 * Pill-style single choice (order type, payment method, login/register ...).
 * Radiogroup semantics with arrow-key navigation; sliding highlight.
 */
export function SegmentedControl<V extends string>({
  options, value, onChange, label, size = "md", block, stacked, className,
}: {
  options: SegmentOption<V>[];
  value: V;
  onChange: (v: V) => void;
  /** Accessible name of the group. */
  label: string;
  size?: "md" | "lg";
  block?: boolean;
  /** Icon above label, for narrow columns (e.g. 4 options in a cart panel). */
  stacked?: boolean;
  className?: string;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: KeyboardEvent, idx: number) {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let n = 1; n <= options.length; n++) {
      const j = (idx + dir * n + options.length * n) % options.length;
      if (!options[j].disabled) { onChange(options[j].value); refs.current[j]?.focus(); return; }
    }
  }
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex gap-1 rounded-2xl border border-border bg-surface-2 p-1", block && "flex w-full", className)}>
      {options.map((o, idx) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[idx] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, idx)}
            className={cn(
              "relative inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-colors disabled:opacity-50 [&_svg]:size-4",
              stacked ? "h-14 px-1 text-xs" : size === "lg" ? "h-12 px-4 text-base" : "h-11 px-4 text-sm",
              on ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {on && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-xl bg-surface shadow-pop ring-1 ring-border" transition={layoutTransition} />}
            <span className={cn("relative z-10 inline-flex items-center gap-2", stacked && "flex-col gap-1")}>{o.icon}{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
