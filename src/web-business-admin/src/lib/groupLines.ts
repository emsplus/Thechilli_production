import { sumMoney } from "./money";

/**
 * Identical lines shown once: "2x Chicken 65 [Mild]" + "1x Chicken 65 [Mild]" is "3x Chicken 65 [Mild]". Lines are identical when the
 * dish (description), option / modifiers (in the description), note, unit price and tax code are the same. Quantities add up and every
 * money field adds up exactly (decimal strings, never floats), so the bill total is the same to the paisa. Order of first appearance is kept.
 */
export interface BillLineLike {
  id?: string; item_id?: string | null; description: string; quantity: number; unit_price: string; line_total: string;
  tax_code?: string | null; tax_rate_percent?: string | null; net_amount?: string | null; vat_amount?: string | null; gross_amount?: string | null; note?: string | null;
}

const key = (l: BillLineLike) => [l.item_id ?? "", l.description, l.unit_price, l.tax_code ?? "", l.tax_rate_percent ?? "", l.note ?? ""].join("\u0001");
const add = (a: string | null | undefined, b: string | null | undefined) => (a == null && b == null ? null : sumMoney([a ?? "0", b ?? "0"]));

export function groupBillLines<T extends BillLineLike>(lines: T[]): T[] {
  const out: T[] = []; const at = new Map<string, number>();
  for (const l of lines) {
    const k = key(l); const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push({ ...l }); continue; }
    const g = out[i];
    out[i] = { ...g, quantity: g.quantity + l.quantity, line_total: sumMoney([g.line_total, l.line_total]),
      ...(g.net_amount != null || l.net_amount != null ? { net_amount: add(g.net_amount, l.net_amount) } : {}),
      ...(g.vat_amount != null || l.vat_amount != null ? { vat_amount: add(g.vat_amount, l.vat_amount) } : {}),
      ...(g.gross_amount != null || l.gross_amount != null ? { gross_amount: add(g.gross_amount, l.gross_amount) } : {}) };
  }
  return out;
}

/** The identity of a cart line for display grouping (dish, option, modifiers, note, unit price). */
export interface CartLineLike { item: { id: string }; variantId: string | null; mods?: { ids: string[] } | null; note?: string; unit: string; qty: number; key: string }
export const cartLineIdentity = (l: CartLineLike) => [l.item.id, l.variantId ?? "", l.mods?.ids.join(",") ?? "", l.note ?? "", l.unit].join("\u0001");

/** Groups identical cart lines for display (placed / billed orders and receipts). `keys` = every original line key of the group. */
export function groupCartLines<T extends CartLineLike>(lines: T[]): (T & { keys: string[] })[] {
  const out: (T & { keys: string[] })[] = []; const at = new Map<string, number>();
  for (const l of lines) {
    const k = cartLineIdentity(l); const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push({ ...l, keys: [l.key] }); continue; }
    out[i] = { ...out[i], qty: out[i].qty + l.qty, keys: [...out[i].keys, l.key] };
  }
  return out;
}
