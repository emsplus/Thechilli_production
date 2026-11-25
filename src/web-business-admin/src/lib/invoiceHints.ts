/** Small pure checks the invoice review screen uses (unit-tested in e2e/match-items.spec.ts). */
import { addDecimal } from "./decimal";
import { normalizedName } from "./matchItems";

/** A supplier's GSTIN as printed on the invoice: "27 aapfu 0939 f1zv" -> "27AAPFU0939F1ZV" (spaces, dashes, dots dropped; never a country prefix). */
export function normaliseGstin(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(/[\s\-.]/g, "").toUpperCase() || null;
}

/** Amber text when an invoice date looks wrong (future, or more than ~60 days old); null when fine. */
export function dateWarning(iso: string | null | undefined, today = new Date()): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00`), t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const days = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (days < 0) return "This date is in the future. Invoices are day/month/year: check the day and month.";
  if (days > 60) return `This date is ${days} days ago. Invoices are day/month/year: check the day, month and year.`;
  return null;
}

const CONSUMABLE = /\b(carrier bags?|bin ?liners?|napkins?|serviettes?|foil|containers?|gloves?|cling ?film|detergent|cleaner|sanitiser|sanitizer|toilet|tissues?|straws?|lids?|cups?|takeaway|disposable|wipes?|aprons?)\b/i;

/** True for lines that look like packaging or cleaning supplies, or that carry GST when the rest of the invoice does not. */
export function looksLikeConsumable(line: { description: string; vat_rate?: string | null }, all: { vat_rate?: string | null }[]): boolean {
  if (CONSUMABLE.test(line.description)) return true;
  const rates = all.map((l) => l.vat_rate).filter((r): r is string => r != null && r !== "");
  return line.vat_rate != null && Number(line.vat_rate) > 0 && rates.length > 1 && rates.filter((r) => Number(r) > 0).length * 2 < rates.length;
}

export interface MergeLine { description: string; quantity: string; unit: string; unit_price: string; item_code?: string | null; item_id?: string | null }

/** Groups of line indexes that look like the same product listed twice (same code, or same name+unit+price). */
export function duplicateGroups(lines: MergeLine[]): number[][] {
  const by = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const key = `${l.item_code || normalizedName(l.description) || l.description.toLowerCase()}|${l.unit}|${Number(l.unit_price)}`;
    by.set(key, [...(by.get(key) ?? []), i]);
  });
  return [...by.values()].filter((g) => g.length > 1);
}

/** Sum of exact decimals. */
export const sumQty = (vals: string[]) => vals.reduce((a, v) => addDecimal(a, v), "0");
