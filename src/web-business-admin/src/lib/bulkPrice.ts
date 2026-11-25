import { BULK_MSG } from "@/app/manage/_components/menu-messages";
import { msg, type Locale } from "./i18n";
import { cmpMoney, pctOfMoney, sumMoney } from "./money";

export type PriceMode = "set" | "add" | "percent";
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const SIGNED = /^-?\d+(\.\d{1,2})?$/;

/** What the input must look like for each mode (message for the form), or null when it is fine. */
export function priceInputProblem(mode: PriceMode, raw: string, locale: Locale = "en"): string | null {
  const v = raw.trim();
  if (mode === "set") return AMOUNT.test(v) ? null : msg(locale, BULK_MSG.problemSet);
  if (mode === "add") return SIGNED.test(v) && Number(v) !== 0 ? null : msg(locale, BULK_MSG.problemAdd);
  return SIGNED.test(v) && Number(v) !== 0 && Math.abs(Number(v)) <= 500 ? null : msg(locale, BULK_MSG.problemPercent);
}

/** New price of one item as a 2-decimal string, exact (no floats), or null when it would go below zero. */
export function bulkPrice(old: string, mode: PriceMode, raw: string): string | null {
  const v = raw.trim();
  let next: string;
  if (mode === "set") next = sumMoney([v]);
  else if (mode === "add") next = sumMoney([old, v]);
  else next = v.startsWith("-") ? sumMoney([old, `-${pctOfMoney(old, v.slice(1))}`]) : sumMoney([old, pctOfMoney(old, v)]);
  return cmpMoney(next, "0") < 0 ? null : next;
}
