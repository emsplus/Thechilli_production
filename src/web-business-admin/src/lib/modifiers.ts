/**
 * Counter-side rules for modifier groups and automatic offers (pure, unit tested). The server re-validates and re-prices
 * everything (docs/MODIFIERS_OFFERS.md); these only drive the picker and the on-device estimate.
 */
import type { AppliedOffer, ModifierGroup, ModifierOption, Offer } from "./extras";
import type { DiscountInput, MenuItem, OrderType } from "./types";
import { formatCurrency } from "./money";

/** Option ids chosen per group id. */
export type Selection = Record<string, string[]>;

/** The item's active groups in the item's own order (unknown / inactive groups are skipped). */
export function groupsFor(item: Pick<MenuItem, "modifier_group_ids">, groups: ModifierGroup[]): ModifierGroup[] {
  const ids = item.modifier_group_ids ?? [];
  if (!ids.length) return [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  return ids.map((id) => byId.get(id)).filter((g): g is ModifierGroup => !!g && g.is_active && g.options.some((o) => o.is_active));
}

const activeOptions = (g: ModifierGroup) => g.options.filter((o) => o.is_active).sort((a, b) => a.sort_order - b.sort_order);

/** The defaults the server would apply when a line is sent without `modifiers`. */
export function defaultSelection(groups: ModifierGroup[]): Selection {
  const out: Selection = {};
  for (const g of groups) out[g.id] = activeOptions(g).filter((o) => o.is_default).map((o) => o.id);
  return out;
}

/** A group's problem with a selection, or null. */
export function groupProblem(g: ModifierGroup, chosen: string[]): string | null {
  if (chosen.length < g.min_select) return g.min_select === 1 ? `Choose ${g.name}` : `Choose at least ${g.min_select} for ${g.name}`;
  if (g.max_select !== null && chosen.length > g.max_select) return `Choose at most ${g.max_select} for ${g.name}`;
  return null;
}

export const selectionValid = (groups: ModifierGroup[], sel: Selection) => groups.every((g) => groupProblem(g, sel[g.id] ?? []) === null);

/**
 * Does a tap on this dish need the picker? Only when there is a real choice the counter cannot make by itself:
 * variants (as before) or a required group without enough defaults. Optional groups and required groups with defaults
 * add NO tap: the dish goes straight in with the defaults (they can be changed from the cart line).
 */
export function needsPicker(item: Pick<MenuItem, "variants" | "modifier_group_ids">, groups: ModifierGroup[]): boolean {
  if (item.variants.length > 0) return true;
  const gs = groupsFor(item, groups);
  return gs.length > 0 && !selectionValid(gs, defaultSelection(gs));
}

/** Tap on an option: single-choice groups swap, multi-choice groups toggle (never past max). */
export function toggleOption(g: ModifierGroup, chosen: string[], optionId: string): string[] {
  if (chosen.includes(optionId)) return g.min_select === 1 && g.max_select === 1 ? chosen : chosen.filter((x) => x !== optionId);
  if (g.max_select === 1) return [optionId];
  if (g.max_select !== null && chosen.length >= g.max_select) return chosen;
  return [...chosen, optionId];
}

export interface ChosenModifiers {
  /** Option ids in group order (what POST /orders `modifiers` takes). */
  ids: string[];
  /** "Hot", "Cheese" (the bill line shows "Chicken Karahi [Hot, Cheese]"). */
  names: string[];
  /** Sum of the option deltas in paise. */
  deltaPaise: number;
}

export function chosenOf(groups: ModifierGroup[], sel: Selection): ChosenModifiers {
  const ids: string[] = []; const names: string[] = []; let deltaPaise = 0;
  for (const g of groups) {
    const picked = new Set(sel[g.id] ?? []);
    for (const o of activeOptions(g)) if (picked.has(o.id)) { ids.push(o.id); names.push(o.name); deltaPaise += o.price_delta_paise; }
  }
  return { ids, names, deltaPaise };
}

/** "+₹20.00" / "−₹5.50" / "" for an option row (formatCurrency: ₹, Indian grouping, two decimals). */
export function deltaLabel(o: Pick<ModifierOption, "price_delta_paise">): string {
  const p = o.price_delta_paise;
  if (!p) return "";
  const abs = Math.abs(p);
  return `${p > 0 ? "+" : "−"}${formatCurrency(`${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`)}`;
}

/** Unit price with the variant and the option deltas, never below 0 (server rule), as "125.50". */
export function unitWithModifiers(base: string, deltaPaise: number): string {
  const paise = Math.max(0, Math.round(Number(base) * 100) + deltaPaise);
  return (paise / 100).toFixed(2);
}

// ---------------------------------------------------------------- offers (on-device estimate only)

export interface OfferLine { itemId: string; categoryId: string; unit: string; qty: number }
const P = (v: string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const R = (p: number) => (p / 100).toFixed(2);

/** Splits `amount` paise over `weights` proportionally (largest remainder), never more than each weight. */
function spread(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const amt = Math.min(amount, total);
  const raw = weights.map((w) => (amt * w) / total);
  const out = raw.map(Math.floor);
  let left = amt - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; if (out[i] < weights[i]) { out[i]++; left--; } }
  return out;
}

/** Per-line discount (paise) of one offer on what is left of the lines; zeros when it does not apply. */
function offerShares(o: Offer, lines: OfferLine[], left: number[], itemsTotal: number, orderType: OrderType): number[] {
  const zero = lines.map(() => 0);
  if (!o.is_active) return zero;
  if (o.order_types && o.order_types.length && !o.order_types.includes(orderType)) return zero;
  if (itemsTotal < P(o.min_order_value)) return zero;
  const targets = new Set(o.target_ids ?? []);
  const eligible = lines.map((l) => o.scope === "bill" || (o.scope === "item" ? targets.has(l.itemId) : targets.has(l.categoryId)));
  const base = left.map((v, i) => (eligible[i] ? v : 0));
  let shares: number[];
  if (o.kind === "percent") shares = base.map((v) => Math.round((v * Number(o.value)) / 100));
  else if (o.scope === "bill") shares = spread(P(o.value), base);
  else shares = base.map((v, i) => Math.min(v, P(o.value) * lines[i].qty)); // "20 off every lassi"
  shares = shares.map((s, i) => Math.min(s, base[i]));
  const sum = shares.reduce((a, b) => a + b, 0);
  const cap = o.max_discount ? P(o.max_discount) : Infinity;
  return sum > cap ? spread(cap, shares) : shares;
}

/**
 * Which running offers apply to these lines and how much each takes (mirrors services/offers.py): among non-stackable
 * offers only the largest applies (ties: higher priority, then name); stackable ones are added after it, each on what is left.
 */
export function estimateOffers(lines: OfferLine[], offers: Offer[], orderType: OrderType): { applied: AppliedOffer[]; total: string } {
  const amounts = lines.map((l) => P(l.unit) * l.qty);
  const itemsTotal = amounts.reduce((a, b) => a + b, 0);
  if (!offers.length || itemsTotal <= 0) return { applied: [], total: "0.00" };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const left = [...amounts];
  const applied: AppliedOffer[] = [];
  const take = (o: Offer, shares: number[]) => {
    const amt = sum(shares);
    if (amt <= 0) return;
    shares.forEach((s, i) => { left[i] -= s; });
    applied.push({ offer_id: o.id, name: o.name, label: o.label || `Offer: ${o.name}`, amount: R(amt) });
  };
  const exclusive = offers.filter((o) => !o.stackable)
    .map((o) => ({ o, shares: offerShares(o, lines, left, itemsTotal, orderType) }))
    .filter((x) => sum(x.shares) > 0)
    .sort((a, b) => sum(b.shares) - sum(a.shares) || b.o.priority - a.o.priority || a.o.name.localeCompare(b.o.name));
  if (exclusive[0]) take(exclusive[0].o, exclusive[0].shares);
  for (const o of offers.filter((x) => x.stackable).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))) take(o, offerShares(o, lines, left, itemsTotal, orderType));
  return { applied, total: R(sum(applied.map((a) => P(a.amount)))) };
}

/**
 * Offers + the cashier's manual discount as ONE amount discount for the on-device tax estimate (the manual part is taken
 * from what the offers left, like the server). Null when there is nothing to take off.
 */
export function combinedDiscount(itemsTotal: string, offerTotal: string, labels: string[], manual: DiscountInput | null): DiscountInput | null {
  const offer = P(offerTotal);
  if (offer <= 0) return manual;
  const rest = Math.max(0, P(itemsTotal) - offer);
  const manualAmt = !manual ? 0 : manual.type === "percent" ? Math.round((rest * Number(manual.value)) / 100) : Math.min(rest, P(manual.value));
  const reason = [labels.join("; "), manual?.reason?.trim()].filter(Boolean).join("; ").slice(0, 200);
  return { type: "amount", value: R(offer + manualAmt), reason: reason.length >= 3 ? reason : "Offer" };
}
