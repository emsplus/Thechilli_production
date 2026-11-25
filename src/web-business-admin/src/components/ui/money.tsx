"use client";

import { cn } from "@/lib/cn";
import { currencyMark, formatMoney, isNegativeMoney } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";

/**
 * Renders a Decimal string ("12.50") with the restaurant's currency and tabular figures: "₹1,23,456.50" (symbol hugging
 * the number, Indian grouping). Always the rupee: `currency` is accepted for callers but every code shows ₹ (src/lib/money.ts).
 * Pure string formatting: no floats are involved.
 */
export function Money({
  value, currency, decimals = 2, showCurrency = true, className, strong, tone,
}: {
  value: string | number | null | undefined;
  currency?: string;
  decimals?: number;
  showCurrency?: boolean;
  strong?: boolean;
  /** "auto" colours negatives with the danger colour. */
  tone?: "auto";
  className?: string;
}) {
  const own = useCurrency();
  const mark = currencyMark(currency ?? own);
  const text = formatMoney(value, decimals);
  const neg = value != null && isNegativeMoney(value);
  const symbol = mark.length === 1 || !/[A-Za-z]/.test(mark);
  return (
    <span className={cn("tnum whitespace-nowrap font-mono", strong && "font-semibold", tone === "auto" && neg && "text-danger-fg", className)}>
      {neg && text.startsWith("-") ? "-" : ""}
      {showCurrency && mark && <span className={cn("text-[0.78em] font-medium text-fg-subtle", symbol ? "mr-[0.08em]" : "mr-[0.3em]")}>{mark}</span>}
      {neg && text.startsWith("-") ? text.slice(1) : text}
    </span>
  );
}
