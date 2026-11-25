"use client";

import type { MouseEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { spring } from "@/lib/motion";
import { NumberRoll } from "./number-roll";

/**
 * − n + quantity stepper. 44px targets by default (POS); `size="sm"` (36px) for dense laptop lists only.
 * Give item-specific labels when several steppers are on screen (Playwright strict mode, screen readers):
 *   <QtyStepper value={qty} onIncrement={..} onDecrement={..} incLabel={`Add one ${name}`} decLabel={`Remove one ${name}`} />
 */
export function QtyStepper({ value, onIncrement, onDecrement, min = 0, max, size = "md", incLabel = "increase", decLabel = "decrease", disabled, className, tone = "neutral" }: {
  value: number;
  /** Receives the click event (e.g. for flyToCart(e.currentTarget)). */
  onIncrement: (e: MouseEvent<HTMLButtonElement>) => void;
  onDecrement: (e: MouseEvent<HTMLButtonElement>) => void;
  min?: number;
  max?: number;
  size?: "sm" | "md";
  incLabel?: string;
  decLabel?: string;
  disabled?: boolean;
  className?: string;
  /** "primary" fills the + button copper (used once a dish is in the cart). */
  tone?: "neutral" | "primary";
}) {
  const btn = size === "sm" ? "size-11 pointer-fine:size-9" : "size-11";
  const icon = size === "sm" ? "size-4" : "size-[1.1rem]";
  const atMin = value <= min;
  const atMax = max != null && value >= max;
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-xl border border-border bg-surface-2/70 p-0.5", className)}>
      <motion.button type="button" aria-label={decLabel} disabled={disabled || atMin} onClick={onDecrement}
        whileTap={{ scale: 0.88 }} transition={spring.snappy}
        className={cn(btn, "grid place-items-center rounded-[0.6rem] text-fg-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40")}>
        <Minus aria-hidden className={icon} />
      </motion.button>
      <span className={cn("min-w-[2ch] text-center font-semibold text-fg", size === "sm" ? "text-sm" : "text-base")} aria-live="polite">
        <NumberRoll value={value} />
      </span>
      <motion.button type="button" aria-label={incLabel} disabled={disabled || atMax} onClick={onIncrement}
        whileTap={{ scale: 0.88 }} transition={spring.snappy}
        className={cn(btn, "grid place-items-center rounded-[0.6rem] transition-colors disabled:opacity-40",
          tone === "primary" ? "bg-primary bg-primary-gradient text-primary-fg shadow-[var(--shadow-inset-hi)]" : "text-fg-muted hover:bg-surface hover:text-fg")}>
        <Plus aria-hidden className={icon} />
      </motion.button>
    </div>
  );
}
