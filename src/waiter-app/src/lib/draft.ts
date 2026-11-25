"use client";
import { useSyncExternalStore } from "react";
import { addLine, lineKey, type CartLine, type Draft, type ServiceMode } from "./cart";
import { activeBill, afterSend, closeBill, conformBills, freshDraft, fromLegacy, newBill, patchActive, switchBill, tidyBills, type Bills } from "./bills";
import { allowedModesNow, defaultModeNow } from "./capsStore";
import { uuid } from "./uuid";

const KEY = "waiter.bills";
const LEGACY_KEY = "waiter.draft";
const EV = "waiter-draft";
let cache: Bills | null = null;
const SERVER: Draft = { client_uuid: "", no: 1, mode: "dine_in", table_id: null, lines: [] };
const SERVER_BILLS: Bills = { active: "", bills: [SERVER] };

function loadBills(): Bills {
  if (cache) return cache;
  try {
    const s = localStorage.getItem(KEY);
    if (s) { const b = JSON.parse(s) as Bills; if (b?.bills?.length) return (cache = tidyBills(b)); }
    const old = localStorage.getItem(LEGACY_KEY);
    if (old) return (cache = fromLegacy(JSON.parse(old) as Draft));
  } catch { /* ignore */ }
  const f = freshDraft(uuid(), 1, defaultModeNow()); // a kitchen starts on takeaway, a restaurant on dine-in
  return (cache = { active: f.client_uuid, bills: [f] });
}
const load = (): Draft => activeBill(loadBills());
function saveBills(b: Bills) {
  cache = b;
  try { localStorage.setItem(KEY, JSON.stringify(b)); localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EV));
}
const save = (f: (d: Draft) => Draft) => saveBills(patchActive(loadBills(), f));

/** Cart "Pick table" / "Change": the next table tapped on the Tables screen moves THIS bill there (for 2 minutes). */
let retarget: { id: string; until: number } | null = null;
/**
 * The bill's items go onto the table the waiter taps next (owner report: items first, table afterwards made a NEW, empty
 * bill and the items stayed behind on a bill without a table): a dine-in bill with items and no table yet, or the bill whose
 * cart "Change" link was used. A bill for a table that already has its items stays where it is (tapping another table on the
 * floor starts another bill, so nothing typed for table 4 ever moves to table 6 by accident).
 */
export function carriesToTable(d: Draft, now = Date.now()): boolean {
  if (!d.lines.length) return false;
  if (retarget && retarget.id === d.client_uuid && retarget.until > now) return true;
  return !d.add_to && d.mode === "dine_in" && !d.table_id;
}

export const draftActions = {
  /** Business type known or changed: bills in a mode this business cannot take move to the default mode (items kept). */
  conform() {
    const s = loadBills(), next = conformBills(s, allowedModesNow(), defaultModeNow());
    if (next !== s) saveBills(next);
  },
  setMode(mode: ServiceMode) {
    if (!allowedModesNow().includes(mode)) return; // never an order type the server would refuse
    save((d) => ({ ...d, mode, table_id: mode === "dine_in" ? d.table_id : null, table_ack: false })); },
  setTable(table_id: string | null, acknowledgedOccupied = false) {
    if (table_id && !allowedModesNow().includes("dine_in")) return;
    save((d) => ({ ...d, mode: "dine_in", table_id, table_ack: acknowledgedOccupied })); },
  add(l: CartLine) { save((d) => ({ ...d, lines: addLine(d.lines, l) })); },
  /** Undo of a voice "done" add: takes these quantities off the active bill again (a line that reaches 0 goes). */
  unadd(lines: CartLine[]) {
    save((d) => {
      let out = d.lines;
      for (const l of lines) out = out.flatMap((x) => (x.key !== l.key ? [x] : x.quantity - l.quantity > 0 ? [{ ...x, quantity: x.quantity - l.quantity }] : []));
      return { ...d, lines: out };
    });
  },
  clearFlash() { if (load().flash) save((d) => ({ ...d, flash: undefined })); },
  /** Puts a removed line back where it was (cart Undo). No-op if an identical line was added meanwhile (it merges). */
  restore(l: CartLine, index: number) {
    save((d) => {
      if (d.lines.some((x) => x.key === l.key)) return { ...d, lines: addLine(d.lines, l) };
      const lines = [...d.lines]; lines.splice(Math.min(index, lines.length), 0, l); return { ...d, lines };
    });
  },
  setQty(key: string, q: number) { save((d) => ({ ...d, lines: q <= 0 ? d.lines.filter((x) => x.key !== key) : d.lines.map((x) => (x.key === key ? { ...x, quantity: Math.min(999, q) } : x)) })); },
  /** Change the quantity of every line of one dish without options (the card stepper); "-" takes from the last line. */
  stepItem(itemId: string, delta: 1 | -1) {
    save((d) => {
      const idx = d.lines.map((l, i) => [l, i] as const).filter(([l]) => l.item_id === itemId && !l.variant_id).map(([, i]) => i);
      if (!idx.length) return d;
      const i = idx[idx.length - 1];
      const q = d.lines[i].quantity + delta;
      return { ...d, lines: q <= 0 ? d.lines.filter((_, j) => j !== i) : d.lines.map((x, j) => (j === i ? { ...x, quantity: Math.min(999, q) } : x)) };
    });
  },
  setLineNote(key: string, note: string) {
    save((d) => {
      const line = d.lines.find((x) => x.key === key);
      if (!line) return d;
      const n = note.trim().slice(0, 300);
      const nk = lineKey(line.item_id, line.variant_id, n, line.modifiers);
      const rest = d.lines.filter((x) => x.key !== key);
      const twin = rest.find((x) => x.key === nk);
      if (twin) return { ...d, lines: rest.map((x) => (x.key === nk ? { ...x, quantity: x.quantity + line.quantity } : x)) };
      return { ...d, lines: d.lines.map((x) => (x.key === key ? { ...x, note: n, key: nk } : x)) };
    });
  },
  /**
   * Tables screen / mode buttons: the active bill takes the table (or mode) while it has no items; a bill that already
   * has items for something else is kept as a tab and a new bill starts, so nothing typed is ever moved to another table.
   */
  startFor(target: { table: string; ack?: boolean } | { mode: ServiceMode }): boolean {
    const allowed = allowedModesNow();
    if ("table" in target ? !allowed.includes("dine_in") : !allowed.includes(target.mode)) return false;
    const s = loadBills();
    const a = activeBill(s);
    const same = "table" in target ? a.mode === "dine_in" && a.table_id === target.table : a.mode === target.mode && !a.table_id;
    const carry = "table" in target && carriesToTable(a); // items first, table afterwards: the items go to that table
    const keep = !carry && a.lines.length > 0 && (!same || !!a.add_to); // otherwise never retarget a bill that already has items
    if ("table" in target) retarget = null;
    const next = keep ? newBill(s, uuid()) : s;
    if (!next) return false; // all bill tabs are in use
    saveBills(patchActive(next, (d) => ("table" in target
      ? { ...d, add_to: null, mode: "dine_in", table_id: target.table, table_ack: !!target.ack }
      : { ...d, add_to: null, mode: target.mode, table_id: target.mode === "dine_in" ? d.table_id : null, table_ack: false })));
    return true;
  },
  setNote(note: string) { save((d) => ({ ...d, note })); },
  setCustomer(customer: { id: string; name: string } | null) { save((d) => ({ ...d, customer })); },
  /** Add items to an existing order: its own bill tab, so a half-taken order on another bill is never lost. */
  addTo(orderClientUuid: string | null, tableId: string | null = null): boolean {
    const s = loadBills();
    const next = newBill(s, uuid());
    if (!next) return false; // all tabs hold items: never turn one of them into an "add to" bill
    saveBills(patchActive(next, (d) => ({ ...d, mode: tableId ? "dine_in" : activeBill(s).mode, table_id: tableId, add_to: orderClientUuid })));
    return true;
  },
  /** Items were taken first and the table tapped afterwards already has an open order: the bill's items are added to THAT order
   *  (add_lines + KOT, the same as "Add items" when the table was picked first). Never a second order on the table. */
  joinOrder(orderClientUuid: string, tableId: string): "carried" | "new_tab" | "full" {
    const carry = this.carriesTo(tableId);
    retarget = null;
    if (!carry) return this.addTo(orderClientUuid, tableId) ? "new_tab" : "full";
    save((d) => ({ ...d, mode: "dine_in", table_id: tableId, table_ack: false, add_to: orderClientUuid }));
    return "carried";
  },
  /** True when the active bill's items go to `tableId` if the waiter taps it now (see carriesToTable); also a bill already made
   *  for this very table (picked while it was free, it got an order from elsewhere since). */
  carriesTo(tableId: string): boolean {
    const a = load();
    return carriesToTable(a) || (a.lines.length > 0 && !a.add_to && a.mode === "dine_in" && a.table_id === tableId);
  },
  /** Cart "Pick table" / "Change": the next table tapped moves this bill. */
  markRetarget() { retarget = { id: load().client_uuid, until: Date.now() + 120_000 }; },
  /** The active bill was queued; see bills.afterSend. */
  reset(flash?: string) { saveBills(afterSend(loadBills(), uuid(), flash)); },
  /** Hold / + New. Returns false when the tab limit is reached. */
  newBill(): boolean { const s = newBill(loadBills(), uuid()); if (!s) return false; saveBills(s); return true; },
  switchBill(id: string) { saveBills(switchBill(loadBills(), id)); },
  closeBill(id: string) { saveBills(closeBill(loadBills(), id, uuid())); },
};

const subscribe = (cb: () => void) => { window.addEventListener(EV, cb); return () => window.removeEventListener(EV, cb); };
export function useDraft(): Draft {
  return useSyncExternalStore(subscribe, load, () => SERVER);
}
export function useBills(): Bills {
  return useSyncExternalStore(subscribe, loadBills, () => SERVER_BILLS);
}
