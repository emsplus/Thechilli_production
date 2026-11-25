import type { LineInput, NewOrder, OrderType } from "./queue/types";
import { addDecimal, fromMinor, mulDecimal, toMinor } from "./money";
import type { DiningTable, MenuItem } from "./types";
import { defaultModifiers, modifiersDelta, type SelectedModifier } from "./modifiers";

import type { ServiceMode } from "./capabilities";
export type { ServiceMode };

export interface CartLine {
  key: string; // item + variant + note: identical lines merge
  item_id: string; name: string; variant_id: string | null; variant_name: string | null;
  unit_price: string; quantity: number; note: string;
  /** Chosen modifier options (dish has modifier groups); sent as their ids, shown under the line. */
  modifiers?: SelectedModifier[];
}
/** add_to: client_uuid of an existing order; then client_uuid is the idempotency key (batch_uuid) of this addition. */
export interface Draft { client_uuid: string; mode: ServiceMode; table_id: string | null; lines: CartLine[]; add_to?: string | null; flash?: string;
  /** The waiter chose to start a separate order on an occupied table (explicit, after the occupied-table prompt). */
  table_ack?: boolean;
  /** Free-text note for the whole order (kitchen / cashier). */
  note?: string;
  /** Bill tab number (lib/bills.ts). */
  no?: number;
  /** Customer attached from the search (sent as customer_id; the name is only for the screen). */
  customer?: { id: string; name: string } | null }

export const lineKey = (itemId: string, variantId: string | null, note: string, mods?: SelectedModifier[]) =>
  `${itemId}|${variantId ?? ""}|${note.trim().toLowerCase()}${mods?.length ? `|${mods.map((m) => m.id).sort().join(",")}` : ""}`;

/** `mods` omitted = the dish's default modifiers (one-tap add); lines with different choices stay separate lines. */
export function makeLine(item: MenuItem, variantId: string | null, quantity: number, note: string, mods: SelectedModifier[] | undefined = defaultModifiers(item)): CartLine {
  const v = item.variants.find((x) => x.id === variantId) ?? null;
  const n = note.trim();
  const base = v ? addDecimal(item.price, v.price_delta) : item.price;
  const line: CartLine = { key: lineKey(item.id, v?.id ?? null, n, mods), item_id: item.id, name: item.name, variant_id: v?.id ?? null, variant_name: v?.name ?? null,
    unit_price: mods?.length ? addDecimal(base, modifiersDelta(mods)) : base, quantity, note: n };
  if (mods) line.modifiers = mods;
  return line;
}

export function addLine(lines: CartLine[], l: CartLine): CartLine[] {
  const i = lines.findIndex((x) => x.key === l.key);
  if (i < 0) return [...lines, l];
  return lines.map((x, j) => (j === i ? { ...x, quantity: Math.min(999, x.quantity + l.quantity) } : x));
}

export const cartTotal = (lines: CartLine[]): string => fromMinor(lines.reduce((s, l) => s + toMinor(mulDecimal(l.unit_price, l.quantity)), 0));

/** Table is mandatory only for dine-in. Takeaway/delivery never carry a table. */
export type DraftProblem = "no_items" | "pick_table" | "table_gone" | "type_not_allowed";
/** `allowed`: the order types this business may take (lib/capabilities allowedModes); omitted = no check (tests, older callers). */
export function validateDraft(d: Draft, tables: DiningTable[], allowed?: readonly ServiceMode[]): DraftProblem | null {
  if (!d.lines.length) return "no_items";
  if (allowed && !d.add_to && !allowed.includes(d.mode)) return "type_not_allowed";
  if (d.mode === "dine_in" && !d.add_to) {
    if (!d.table_id) return "pick_table";
    if (!tables.some((t) => t.id === d.table_id)) return "table_gone";
  }
  return null;
}

export const NOTE_MAX = 300;
/** Counter token: whole number 1..9999, or null when the field is empty (the app then takes the next counter value). */
export function parseToken(input: string): number | null | "invalid" {
  const v = input.trim();
  if (!v) return null;
  return /^\d{1,4}$/.test(v) && Number(v) >= 1 ? Number(v) : "invalid";
}

/** pos-service has indoor/outdoor/takeaway/delivery; dine-in maps to the table's area. */
export function resolveOrderType(d: Draft, tables: DiningTable[]): OrderType {
  if (d.mode === "takeaway") return "takeaway";
  if (d.mode === "delivery") return "delivery";
  return tables.find((t) => t.id === d.table_id)?.area ?? "indoor";
}

export function toNewOrder(d: Draft, tables: DiningTable[], token?: number | null): NewOrder {
  const lines: LineInput[] = d.lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, quantity: l.quantity, note: l.note || null, ...(l.modifiers ? { modifiers: l.modifiers.map((m) => m.id) } : {}), expected_unit_price: l.unit_price }));
  const note = d.note?.trim().slice(0, NOTE_MAX) || null;
  // table_ack: the waiter explicitly chose "separate order" on an occupied table; the server refuses a second order otherwise.
  const second = d.mode === "dine_in" && !!d.table_id && !!d.table_ack;
  return { client_uuid: d.client_uuid, order_type: resolveOrderType(d, tables), table_id: d.mode === "dine_in" ? d.table_id : null, lines, ...(token ? { token } : {}), ...(note ? { note } : {}), ...(d.customer ? { customer_id: d.customer.id } : {}), ...(second ? { allow_second_order: true } : {}) };
}
