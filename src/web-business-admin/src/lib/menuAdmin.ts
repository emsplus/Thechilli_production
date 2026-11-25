import type { ModifierGroup, ModifierGroupInput, Offer, OfferInput, OfferKind, OfferScope } from "./extras";
import type { OrderType } from "./types";

/** "Required · choose 1", "Optional · up to 3", "Choose 1 to 2". */
export function ruleText(g: Pick<ModifierGroup, "min_select" | "max_select">): string {
  const { min_select: min, max_select: max } = g;
  if (min === 0) return max === null ? "Optional · any number" : max === 1 ? "Optional · pick 1" : `Optional · up to ${max}`;
  if (max === min) return `Required · choose ${min}`;
  return max === null ? `Required · at least ${min}` : `Required · ${min} to ${max}`;
}

export interface OptRow { key: string; id: string | null; name: string; rupees: string; isDefault: boolean }
let rowSeq = 0;
export const newRow = (p: Partial<OptRow> = {}): OptRow => ({ key: `r${++rowSeq}`, id: null, name: "", rupees: "0", isDefault: false, ...p });
const RUPEES = /^-?\d{1,6}(\.\d{1,2})?$/;

/** Form state -> request body, or the first problem (shown inline). Pure: unit tested. */
export function groupBody(name: string, min: string, max: string, rows: OptRow[]): { body: ModifierGroupInput } | { error: string } {
  const filled = rows.filter((r) => r.name.trim());
  if (!name.trim()) return { error: "Enter a group name" };
  if (!filled.length) return { error: "Add at least one option" };
  if (!/^\d{1,2}$/.test(min)) return { error: "Minimum must be a whole number" };
  if (max.trim() && !/^\d{1,2}$/.test(max)) return { error: "Maximum must be a whole number, or empty for no limit" };
  const lo = Number(min); const hi = max.trim() ? Number(max) : null;
  if (hi !== null && hi < 1) return { error: "Maximum must be at least 1" };
  if (hi !== null && lo > hi) return { error: "Minimum cannot be more than the maximum" };
  if (lo > filled.length) return { error: `Add at least ${lo} options or lower the minimum` };
  const bad = filled.find((r) => !RUPEES.test(r.rupees.trim() || "0"));
  if (bad) return { error: `Price change of ${bad.name.trim()} must be an amount like 20 or 20.50` };
  const defaults = filled.filter((r) => r.isDefault).length;
  if (hi !== null && defaults > hi) return { error: `At most ${hi} default ${hi === 1 ? "option" : "options"}` };
  const names = new Set<string>();
  for (const r of filled) { const n = r.name.trim().toLowerCase(); if (names.has(n)) return { error: `${r.name.trim()} is listed twice` }; names.add(n); }
  return { body: { name: name.trim(), min_select: lo, max_select: hi, options: filled.map((r, i) => ({ id: r.id, name: r.name.trim(), price_delta_paise: Math.round(Number(r.rupees.trim() || "0") * 100), is_default: r.isDefault, sort_order: i })) } };
}


// ---------------------------------------------------------------- offers

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const ORDER_TYPE_NAMES: Record<OrderType, string> = { indoor: "Dine-in", outdoor: "Outdoor", takeaway: "Takeaway", delivery: "Delivery" };

export interface OfferForm {
  name: string; kind: OfferKind; value: string; scope: OfferScope; targets: string[]; minOrder: string; maxDiscount: string;
  days: number[]; start: string; end: string; from: string; to: string; orderTypes: OrderType[]; stackable: boolean; active: boolean; priority: number;
}
export const blankOffer = (): OfferForm => ({ name: "", kind: "percent", value: "", scope: "bill", targets: [], minOrder: "", maxDiscount: "", days: [], start: "", end: "", from: "", to: "", orderTypes: [], stackable: false, active: true, priority: 0 });
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");
export const formOf = (o: Offer): OfferForm => ({
  name: o.name, kind: o.kind, value: String(Number(o.value)), scope: o.scope, targets: o.target_ids ?? [], minOrder: Number(o.min_order_value) ? String(Number(o.min_order_value)) : "",
  maxDiscount: o.max_discount ? String(Number(o.max_discount)) : "", days: o.days_of_week ?? [], start: hhmm(o.start_time), end: hhmm(o.end_time),
  from: o.valid_from ?? "", to: o.valid_to ?? "", orderTypes: o.order_types ?? [], stackable: o.stackable, active: o.is_active, priority: o.priority,
});
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

/** Offer form -> OfferIn body, or the first problem. Empty lists mean "every" (days / order types). Pure: unit tested. */
export function offerBody(f: OfferForm): { body: OfferInput } | { error: string } {
  if (!f.name.trim()) return { error: "Enter a name, for example Lunch 10%" };
  if (!AMOUNT.test(f.value.trim()) || Number(f.value) <= 0) return { error: f.kind === "percent" ? "Enter the percent off, like 10" : "Enter the amount off, like 50" };
  if (f.kind === "percent" && Number(f.value) > 100) return { error: "A percent offer cannot be more than 100%" };
  if (f.scope !== "bill" && f.targets.length === 0) return { error: f.scope === "item" ? "Choose at least one dish" : "Choose at least one category" };
  if (f.minOrder.trim() && !AMOUNT.test(f.minOrder.trim())) return { error: "Minimum order must be an amount like 500" };
  if (f.maxDiscount.trim() && (!AMOUNT.test(f.maxDiscount.trim()) || Number(f.maxDiscount) <= 0)) return { error: "Maximum discount must be an amount like 100" };
  if (!!f.start !== !!f.end) return { error: "Set both the start and the end time, or neither" };
  if (f.start && f.start === f.end) return { error: "Start and end time cannot be the same" };
  if (f.from && f.to && f.from > f.to) return { error: "The end date is before the start date" };
  return { body: {
    name: f.name.trim(), kind: f.kind, value: f.value.trim(), scope: f.scope, target_ids: f.scope === "bill" ? null : f.targets,
    min_order_value: f.minOrder.trim() || "0", max_discount: f.maxDiscount.trim() || null,
    days_of_week: f.days.length === 0 || f.days.length === 7 ? null : [...f.days].sort(), start_time: f.start || null, end_time: f.end || null,
    valid_from: f.from || null, valid_to: f.to || null, order_types: f.orderTypes.length === 0 || f.orderTypes.length === 4 ? null : f.orderTypes,
    stackable: f.stackable, priority: f.priority, outlet_id: null, is_active: f.active,
  } };
}

/** "Mon–Fri", "Sat, Sun", "Every day". */
export function daysText(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return "Every day";
  const d = [...days].sort();
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run && d.length > 2 ? `${WEEKDAYS[d[0]]}–${WEEKDAYS[d[d.length - 1]]}` : d.map((x) => WEEKDAYS[x]).join(", ");
}

/** One line for the list: "10% off the bill · Mon–Fri 12:00–15:00 · min ₹500 · up to ₹100 · Dine-in". */
export function offerSummary(o: Pick<Offer, "kind" | "value" | "scope" | "target_ids" | "min_order_value" | "max_discount" | "days_of_week" | "start_time" | "end_time" | "order_types" | "valid_from" | "valid_to" | "stackable">, money: (v: string) => string): string {
  const what = o.kind === "percent" ? `${Number(o.value)}% off` : `${money(o.value)} off`;
  const n = o.target_ids?.length ?? 0;
  const where = o.scope === "bill" ? "the bill" : o.scope === "item" ? (o.kind === "amount" ? `every unit of ${n === 1 ? "1 dish" : `${n} dishes`}` : n === 1 ? "1 dish" : `${n} dishes`) : n === 1 ? "1 category" : `${n} categories`;
  const parts = [`${what} ${where}`];
  const when = daysText(o.days_of_week) + (o.start_time && o.end_time ? ` ${hhmm(o.start_time)}–${hhmm(o.end_time)}` : "");
  parts.push(when);
  if (Number(o.min_order_value) > 0) parts.push(`min ${money(o.min_order_value)}`);
  if (o.max_discount) parts.push(`up to ${money(o.max_discount)}`);
  if (o.order_types?.length) parts.push(o.order_types.map((t) => ORDER_TYPE_NAMES[t]).join(", "));
  if (o.valid_from || o.valid_to) parts.push(o.valid_from && o.valid_to ? `${o.valid_from} to ${o.valid_to}` : o.valid_from ? `from ${o.valid_from}` : `until ${o.valid_to}`);
  if (o.stackable) parts.push("adds to other offers");
  return parts.join(" · ");
}

// ---------------------------------------------------------------- menu display
/** "GST 5%" for a dish: its own GST rate code (gst_18, none) when set, else the restaurant's standard rate. */
export function gstRateText(item: { gst_rate_code?: string | null }, rates: { code: string; rate_percent: string }[] | undefined): string | null {
  const code = item.gst_rate_code;
  if (code === "none") return "No GST";
  const m = code ? /(\d+(?:\.\d+)?)/.exec(code) : null;
  if (m) return `GST ${Number(m[1])}%`;
  const std = rates?.find((r) => r.code === "standard");
  return std ? `GST ${Number(std.rate_percent)}%` : null;
}

/** The FSSAI food mark of a dish as the UI draws it. */
export type FoodKind = "veg" | "nonveg" | "egg";
/** The pos-service value (menu_items.food_type); null = not marked. */
export type FoodType = "veg" | "non_veg" | "egg";
/** menu_items.description limit (characters, after trimming). */
export const DESCRIPTION_MAX = 280;

/** Veg / non-veg / egg when the server sends it (`food_type`, or a legacy `is_veg`); null = not marked (no mark is drawn). */
export function vegOf(item: { is_veg?: boolean | null; food_type?: string | null }): FoodKind | null {
  const f = (item.food_type ?? "").toLowerCase();
  if (f === "veg" || f === "vegetarian" || f === "vegan") return "veg";
  if (f === "egg") return "egg";
  if (f === "non_veg" || f === "nonveg" || f === "non-veg") return "nonveg";
  if (typeof item.is_veg === "boolean") return item.is_veg ? "veg" : "nonveg";
  return null;
}

/** UI kind -> the API value (null = not marked). */
export const foodTypeOf = (k: FoodKind | null): FoodType | null => (k === "nonveg" ? "non_veg" : k);

/** Plain words for the mark (screen readers, CSV, the editor). */
export const FOOD_LABEL: Record<FoodKind, string> = { veg: "Veg", nonveg: "Non-veg", egg: "Egg" };

/** What the description is saved as: whitespace runs collapse to one space (it is one line on cards), "" = none. */
export const cleanDescription = (s: string): string => s.replace(/\s+/g, " ").trim();

/** "Veg only" at the counter: egg and unmarked dishes are not veg (a guest asking for veg must never get an unknown). */
export const isVegOnlyMatch = (item: { is_veg?: boolean | null; food_type?: string | null }): boolean => vegOf(item) === "veg";
