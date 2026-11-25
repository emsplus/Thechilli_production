import { mulMoney, sumMoney } from "@/lib/money";
import { uuid } from "@/lib/uuid";
import type { DiningTable, MenuItem, OrderType } from "@/lib/types";
import { unitWithModifiers } from "@/lib/modifiers";
import { tableWhere } from "@/lib/tableWhere";
import type { CartLine, LineMods, Stage, Ticket } from "./types";

export const newTicket = (no: number, type: OrderType = "takeaway"): Ticket => ({
  id: uuid(), no, createdAt: new Date().toISOString(), lines: [], type, tableId: "", customerId: "",
  order: null, kot: null, bill: null, prov: null, payKey: null, discount: null, serviceCharge: true,
});

export const needsTable = (t: Pick<Ticket, "type">) => t.type === "indoor" || t.type === "outdoor";
/** The tables to offer while a ticket is being set up: a Dine-in (indoor) order picks from the indoor tables only and an Outdoor order from the outdoor tables only;
 *  takeaway and delivery need none. (After the order is placed "Change table" still offers every table: moving an order between areas is allowed.) */
export const tablesForType = (tables: DiningTable[], type: OrderType): DiningTable[] =>
  (type === "indoor" || type === "outdoor" ? tables.filter((x) => x.area === type) : tables);

export function stageOf(t: Ticket): Stage {
  if (t.prov || (t.bill && Number(t.bill.balance_due) === 0)) return "paid";
  if (t.bill) return "billed";
  if (t.kot !== null) return "kitchen";
  if (t.order) return "placed";
  return "draft";
}

export const itemCount = (lines: CartLine[]) => lines.reduce((n, l) => n + l.qty, 0);
export const estimateOf = (lines: CartLine[]) => sumMoney(lines.map((l) => mulMoney(l.unit, l.qty)));

/** Placed or in the kitchen, not billed: the customer may still order more (the new items collect in `more`). */
export const canAddMore = (t: Ticket) => { const s = stageOf(t); return s === "placed" || s === "kitchen"; };

/** `extra` merged into `lines` by cart key (same dish + option = one line with the summed quantity). */
export const mergeLines = (lines: CartLine[], extra: CartLine[]): CartLine[] =>
  extra.reduce((acc, l) => (acc.some((x) => x.key === l.key) ? acc.map((x) => (x.key === l.key ? { ...x, qty: x.qty + l.qty } : x)) : [...acc, l]), lines);

/** Subtotal the ticket currently stands at: the server's once placed (plus the estimate of items not added yet), the cart estimate before. */
export function subtotalOf(t: Ticket): string {
  if (t.bill) return t.bill.subtotal;
  return t.order ? sumMoney([t.order.subtotal, estimateOf(t.more ?? [])]) : estimateOf(t.lines);
}

export const TYPE_NAME: Record<OrderType, string> = { indoor: "Dine-in", outdoor: "Outdoor", takeaway: "Takeaway", delivery: "Delivery" };

/** The ticket's NAME on this screen: "Bill 3". Not the legal invoice number (INV-…), which only exists once it is billed. */
export const ticketLabel = (t: Pick<Ticket, "no">): string => `Bill ${t.no}`;

/** Small badge beside the name: "Table T3 · Indoor" (the table's own area), "Takeaway". */
export function ticketBadge(t: Ticket, tables: DiningTable[]): string {
  const table = needsTable(t) && t.tableId ? tables.find((x) => x.id === t.tableId) : undefined;
  return table ? tableWhere(table) : TYPE_NAME[t.type];
}

/** Lowest bill number not used by a ticket still on this screen (a closed or dismissed ticket frees its number). */
export function lowestFreeNo(tickets: Pick<Ticket, "no">[]): number {
  const used = new Set(tickets.map((t) => t.no));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Table id -> ticket numbers that hold it while still unplaced (two unplaced tickets must not share a table). */
export function tableClaims(tickets: Ticket[]): Map<string, Ticket[]> {
  const m = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (t.order || !needsTable(t) || !t.tableId) continue;
    m.set(t.tableId, [...(m.get(t.tableId) ?? []), t]);
  }
  return m;
}

/** Same dish + option (+ the same modifier choices) = one line. Lines without modifiers keep the original key. */
export function cartKey(item: MenuItem, variantId: string | null, mods?: LineMods | null, note?: string | null) {
  return `${item.id}:${variantId ?? ""}${mods ? `:${mods.ids.join(",")}` : ""}${note ? `#${note}` : ""}`;
}

/**
 * The option a tap adds without asking (C-03), the same rule as the server (docs/ORDER_RULES.md 2): the menu's
 * `default_variant_id` when the server sends it; else the option marked default; else the cheapest option that costs nothing
 * extra ("Half"); else none (every option costs extra: the plain dish is a real choice).
 */
type SizeInfo = Pick<MenuItem, "variants" | "default_variant_id" | "base_orderable">;
export function defaultVariantId(item: SizeInfo): string | null {
  if (item.default_variant_id !== undefined) return item.default_variant_id && item.variants.some((v) => v.id === item.default_variant_id) ? item.default_variant_id : null;
  const marked = item.variants.find((v) => v.is_default);
  if (marked) return marked.id;
  let best: MenuItem["variants"][number] | null = null;
  for (const v of item.variants) if (Number(v.price_delta) <= 0 && (!best || Number(v.price_delta) < Number(best.price_delta))) best = v;
  return best?.id ?? null;
}

/** The dish can be ordered without an option: only then is there a "Regular" choice (never beside Half / Full at the same price). */
export const baseOrderable = (item: SizeInfo) => item.variants.length === 0 || (item.base_orderable ?? defaultVariantId(item) === null);

/** The choices of a dish with options: null = "Regular" (only when base orderable), then the options. */
export const sizeChoices = (item: SizeInfo): { id: string | null; name: string; price_delta: string }[] =>
  [...(baseOrderable(item) ? [{ id: null, name: "Regular", price_delta: "0.00" }] : []), ...item.variants];

/** The one other choice of a two-choice dish ("Full" for a Half line), or null (none, or three or more: use the picker). */
export function otherVariant(item: SizeInfo, variantId: string | null) {
  const c = sizeChoices(item);
  if (item.variants.length === 0 || c.length !== 2) return null;
  return c.find((v) => v.id !== variantId) ?? null;
}

/** Price difference of a variant against the default one, as "+₹120" (empty when the same). */
export function variantDelta(item: SizeInfo, variantId: string | null, mark = "₹"): string {
  const base = Number(item.variants.find((v) => v.id === defaultVariantId(item))?.price_delta ?? 0);
  const d = Math.round((Number(item.variants.find((v) => v.id === variantId)?.price_delta ?? 0) - base) * 100);
  if (!d) return "";
  const r = Math.abs(d) % 100 === 0 ? String(Math.abs(d) / 100) : (Math.abs(d) / 100).toFixed(2);
  return `${d > 0 ? "+" : "−"}${mark}${r}`;
}

/** "Chicken Karahi (Full) [Hot, Cheese]": the text the server prints on the bill line. */
export function lineLabel(item: MenuItem, variantName?: string | null, mods?: LineMods | null): string {
  const base = variantName ? `${item.name} (${variantName})` : item.name;
  return mods && mods.names.length ? `${base} [${mods.names.join(", ")}]` : base;
}

/** Pure cart reducers (return new arrays). */
export function addLine(lines: CartLine[], item: MenuItem, variantId: string | null, mods?: LineMods | null, note?: string | null): CartLine[] {
  const v = item.variants.find((x) => x.id === variantId);
  const key = cartKey(item, variantId, mods, note);
  if (lines.some((l) => l.key === key)) return lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l));
  const base = sumMoney([item.price, v?.price_delta ?? "0"]);
  return [...lines, { key, item, variantId, label: lineLabel(item, v?.name, mods), unit: mods ? unitWithModifiers(base, mods.deltaPaise) : base, qty: 1, ...(mods ? { mods } : {}), ...(note ? { note } : {}) }];
}

/** Rebuilds a line with another variant and / or note (new key and price), merging into an identical line. */
function reshape(lines: CartLine[], key: string, next: { variantId: string | null; note: string | undefined }): CartLine[] {
  const l = lines.find((x) => x.key === key);
  if (!l) return lines;
  const nk = cartKey(l.item, next.variantId, l.mods, next.note);
  if (nk === key) return lines;
  if (lines.some((x) => x.key === nk)) return lines.filter((x) => x.key !== key).map((x) => (x.key === nk ? { ...x, qty: x.qty + l.qty } : x));
  const v = l.item.variants.find((x) => x.id === next.variantId);
  const base = sumMoney([l.item.price, v?.price_delta ?? "0"]);
  const { note: _old, check: _chk, ...rest } = l; void _old; void _chk;
  return lines.map((x) => (x.key === key ? { ...rest, key: nk, variantId: next.variantId, label: lineLabel(l.item, v?.name, l.mods),
    unit: l.mods ? unitWithModifiers(base, l.mods.deltaPaise) : base, ...(next.note ? { note: next.note } : {}) } : x));
}

/** "Change to Full" on a cart line (null = "Regular", only for a dish that may be ordered without an option). */
export const setLineVariant = (lines: CartLine[], key: string, variantId: string | null) =>
  reshape(lines, key, { variantId, note: lines.find((x) => x.key === key)?.note });

/** Kitchen note on a cart line ("no onion"); empty text removes it. */
export const setLineNote = (lines: CartLine[], key: string, note: string) => {
  const l = lines.find((x) => x.key === key);
  return l ? reshape(lines, key, { variantId: l.variantId, note: note.trim().slice(0, 300) || undefined }) : lines;
};

/** The cashier changed a line's modifier choices: the line takes the new key / price (merging into an identical line). */
export function setLineMods(lines: CartLine[], key: string, mods: LineMods): CartLine[] {
  const l = lines.find((x) => x.key === key);
  if (!l) return lines;
  const nk = cartKey(l.item, l.variantId, mods, l.note);
  if (nk === key) return lines;
  if (lines.some((x) => x.key === nk)) return lines.filter((x) => x.key !== key).map((x) => (x.key === nk ? { ...x, qty: x.qty + l.qty } : x));
  const v = l.item.variants.find((x) => x.id === l.variantId);
  const unit = unitWithModifiers(sumMoney([l.item.price, v?.price_delta ?? "0"]), mods.deltaPaise);
  return lines.map((x) => (x.key === key ? { ...x, key: nk, label: lineLabel(l.item, v?.name, mods), unit, mods } : x));
}

/** API order line: `modifiers` only when the line has them (lines of plain dishes are unchanged). */
export const apiLine = (l: CartLine, withPrice = false) => ({
  item_id: l.item.id, variant_id: l.variantId, quantity: l.qty,
  ...(l.mods ? { modifiers: l.mods.ids } : {}),
  ...(l.note ? { note: l.note } : {}),
  ...(withPrice ? { expected_unit_price: l.unit } : {}),
});
export const changeLine = (lines: CartLine[], key: string, d: number): CartLine[] =>
  lines.map((l) => { if (l.key !== key) return l; const { check: _c, ...rest } = l; void _c; return { ...rest, qty: l.qty + d }; }).filter((l) => l.qty > 0); // an edit also settles a voice "Check" marker

/** Staff looked at a voice line marked "Check": the marker goes. */
export const confirmLine = (lines: CartLine[], key: string): CartLine[] =>
  lines.map((l) => { if (l.key !== key || !l.check) return l; const { check: _c, ...rest } = l; void _c; return rest; });

/** Marks the cart line for this dish "Check" (added by voice with a doubt). */
export const markCheck = (lines: CartLine[], key: string): CartLine[] => lines.map((l) => (l.key === key ? { ...l, check: true } : l));

/** Finished tickets older than this are dropped when the page loads. */
export const DONE_TTL_MS = 2 * 60 * 60 * 1000;
