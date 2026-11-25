import { cartTotal, type Draft, type ServiceMode } from "./cart";
import { formatMoney } from "./money";
import type { DiningTable } from "./types";

/**
 * Bill tabs, as on the original counter (Bill 1, Bill 2, Hold): a waiter can keep several unsent orders open at once
 * (a takeaway at the counter while table 4 is still choosing). Pure state functions; lib/draft.ts persists them.
 * Every bill is an ordinary Draft with its own client_uuid, so the offline queue and its idempotency are unchanged.
 */
export interface Bills { active: string; bills: Draft[] }
export const MAX_BILLS = 6;

export const lowestFreeNo = (bills: Draft[]): number => {
  const used = new Set(bills.map((b) => b.no ?? 0));
  let n = 1;
  while (used.has(n)) n++;
  return n;
};

export const freshDraft = (id: string, no: number, mode: ServiceMode = "dine_in"): Draft => ({ client_uuid: id, no, mode, table_id: null, lines: [] });

export const activeBill = (s: Bills): Draft => s.bills.find((b) => b.client_uuid === s.active) ?? s.bills[0];

export const isEmptyBill = (d: Draft): boolean => !d.lines.length && !d.add_to && !d.table_id && !d.note?.trim() && !d.customer;
/** Nothing typed on it (a table or "add to order" target alone is not work): such a bill is reused before a new one is opened.
 *  Before this, every table tapped with a full cart left a table-only bill behind, and after six of them the waiter got
 *  "6 bills are already open" and could not pick a table at all (owner screenshot, Android v2). */
export const isBlankBill = (d: Draft): boolean => !d.lines.length && !d.note?.trim() && !d.customer;

/** Drops blank bills that are not the active one (left behind by earlier versions). Same object when nothing changes. */
export function tidyBills(s: Bills): Bills {
  const a = activeBill(s);
  const bills = s.bills.filter((b) => b.client_uuid === a.client_uuid || !isBlankBill(b));
  return bills.length === s.bills.length ? s : { ...s, bills };
}

/** Replace the active bill. */
export const patchActive = (s: Bills, f: (d: Draft) => Draft): Bills => {
  const a = activeBill(s);
  return { ...s, bills: s.bills.map((b) => (b.client_uuid === a.client_uuid ? f(b) : b)) };
};

/** "Hold" / "+ New": keep the current bill as a tab and start another. An empty current bill is reused, never duplicated. */
export function newBill(s: Bills, id: string): Bills | null {
  s = tidyBills(s);
  const a = activeBill(s);
  // The current bill has nothing typed on it: reuse it (cleared of a leftover table / "add to" target), never open another.
  if (isBlankBill(a)) return isEmptyBill(a) ? s : { ...s, bills: s.bills.map((b) => (b === a ? freshDraft(a.client_uuid, a.no ?? 1, a.mode) : b)) };
  if (s.bills.length >= MAX_BILLS) return null;
  const b = freshDraft(id, lowestFreeNo(s.bills), a.mode === "dine_in" ? "dine_in" : a.mode);
  return { active: b.client_uuid, bills: [...s.bills, b] };
}

export const switchBill = (s: Bills, id: string): Bills => (s.bills.some((b) => b.client_uuid === id) ? { ...s, active: id } : s);

/** Close a tab (discarding its unsent lines; the screen asks first when it has any). Always leaves one bill. */
export function closeBill(s: Bills, id: string, newId: string): Bills {
  const rest = s.bills.filter((b) => b.client_uuid !== id);
  if (!rest.length) { const f = freshDraft(newId, 1, activeBill(s).mode); return { active: f.client_uuid, bills: [f] }; }
  return { active: s.active === id ? rest[rest.length - 1].client_uuid : s.active, bills: rest };
}

/**
 * The active bill was queued: drop it. Another held bill becomes active, otherwise a fresh bill keeps the service mode
 * (a counter doing takeaway all day lands on a fresh takeaway bill). `flash` is a one-line confirmation for that bill.
 */
export function afterSend(s: Bills, newId: string, flash?: string): Bills {
  const sent = activeBill(s);
  const rest = s.bills.filter((b) => b.client_uuid !== sent.client_uuid);
  if (rest.length) {
    const next = rest[rest.length - 1];
    return { active: next.client_uuid, bills: rest.map((b) => (b.client_uuid === next.client_uuid ? { ...b, flash } : b)) };
  }
  const f = { ...freshDraft(newId, 1, sent.mode), flash };
  return { active: f.client_uuid, bills: [f] };
}

/**
 * The business type changed (or this device had a bill from before it was known): a bill whose service mode is not allowed any more
 * moves to `fallback`, without a table, and keeps its items. A bill that adds to an existing order is left alone (its order has its
 * own type). Returns the SAME object when nothing changes, so callers can skip a write.
 */
export function conformBills(s: Bills, allowed: readonly ServiceMode[], fallback: ServiceMode): Bills {
  let changed = false;
  const bills = s.bills.map((b) => {
    if (b.add_to || allowed.includes(b.mode)) return b;
    changed = true;
    return { ...b, mode: fallback, table_id: null, table_ack: false };
  });
  return changed ? { ...s, bills } : s;
}

/** Tab text: what the waiter recognises the bill by. */
export function billLabel(d: Draft, tables: DiningTable[]): string {
  if (d.add_to) return d.table_id && tables.some((t) => t.id === d.table_id) ? `Add to ${tables.find((t) => t.id === d.table_id)!.label}` : "Add to order";
  if (d.mode === "dine_in" && d.table_id) return `Table ${tables.find((t) => t.id === d.table_id)?.label ?? "?"}`;
  if (d.mode === "takeaway") return `Takeaway${(d.no ?? 1) > 1 ? ` ${d.no}` : ""}`;
  if (d.mode === "delivery") return `Delivery${(d.no ?? 1) > 1 ? ` ${d.no}` : ""}`;
  return `Bill ${d.no ?? 1}`;
}

/**
 * Screen-reader name of a bill tab. The tab shows "Bill 1" and "1 · ₹50.00" in two lines, which a screen reader joined into
 * "Bill 11 · ₹50.00" (D11 of docs/testing/BREAK_UI_REPORT.md): the bill number and the item count ran together.
 */
export function billTabName(d: Draft, tables: DiningTable[]): string {
  const n = d.lines.reduce((x, l) => x + l.quantity, 0);
  return `${billLabel(d, tables)}, ${n ? `${n} item${n === 1 ? "" : "s"}, ${formatMoney(cartTotal(d.lines))}` : "empty"}`;
}

/** Old single-draft storage (waiter.draft) becomes bill 1. */
export const fromLegacy = (d: Draft): Bills => ({ active: d.client_uuid, bills: [{ ...d, no: d.no ?? 1 }] });
