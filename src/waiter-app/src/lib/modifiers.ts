import { fromMinor } from "./money";
import type { MenuItem, ModifierGroup } from "./types";

/**
 * Modifier groups (pos-service docs/MODIFIERS_OFFERS.md): "Spice level" (choose 1), "Extras" (up to 3) attached to a dish.
 * Rules kept from the original counter: a dish whose required groups all have a default adds with ONE tap (defaults
 * applied, nothing extra to press); the option sheet shows groups only when the dish has any.
 */
export interface SelectedModifier { id: string; group_id: string; group: string; name: string; delta_paise: number }
export type Selection = Record<string, string[]>; // group id -> option ids

let registry = new Map<string, ModifierGroup>();
/** Set by the menu provider from the cached menu snapshot (same pattern as the currency symbol). */
let registered: ModifierGroup[] | undefined;
export function setModifierGroups(groups: ModifierGroup[] | undefined) {
  if (groups === registered) return;
  registered = groups;
  registry = new Map((groups ?? []).map((g) => [g.id, g]));
}

/** The dish's active groups in the dish's order, each with its active options only. Unknown ids (stale cache) are skipped. */
export function groupsFor(item: Pick<MenuItem, "modifier_group_ids">, groups: Map<string, ModifierGroup> = registry): ModifierGroup[] {
  return (item.modifier_group_ids ?? []).map((id) => groups.get(id)).filter((g): g is ModifierGroup => !!g && g.is_active)
    .map((g) => ({ ...g, options: g.options.filter((o) => o.is_active).sort((a, b) => a.sort_order - b.sort_order) }));
}

export const defaultSelection = (groups: ModifierGroup[]): Selection =>
  Object.fromEntries(groups.map((g) => [g.id, g.options.filter((o) => o.is_default).map((o) => o.id).slice(0, g.max_select ?? undefined)]));

/** A required group without enough defaults: the dish cannot be added with one tap (the sheet must ask). */
export const needsChoice = (groups: ModifierGroup[]): boolean => groups.some((g) => g.options.filter((o) => o.is_default).length < g.min_select);

/** Tap on an option: single-choice groups replace, multi-choice toggle (never beyond max). */
export function toggleOption(sel: Selection, g: ModifierGroup, optionId: string): Selection {
  const cur = sel[g.id] ?? [];
  if (g.max_select === 1) return { ...sel, [g.id]: g.min_select >= 1 || !cur.includes(optionId) ? [optionId] : [] };
  if (cur.includes(optionId)) return { ...sel, [g.id]: cur.filter((x) => x !== optionId) };
  if (g.max_select !== null && cur.length >= g.max_select) return sel;
  return { ...sel, [g.id]: [...cur, optionId] };
}

/** First problem, in words for staff, or null. */
export function selectionProblem(groups: ModifierGroup[], sel: Selection): string | null {
  for (const g of groups) {
    const n = (sel[g.id] ?? []).length;
    if (n < g.min_select) return g.min_select === 1 ? `Choose ${g.name}` : `Choose at least ${g.min_select} for ${g.name}`;
    if (g.max_select !== null && n > g.max_select) return `Choose at most ${g.max_select} for ${g.name}`;
  }
  return null;
}

export function selectedModifiers(groups: ModifierGroup[], sel: Selection): SelectedModifier[] {
  const out: SelectedModifier[] = [];
  for (const g of groups) for (const o of g.options) if ((sel[g.id] ?? []).includes(o.id)) out.push({ id: o.id, group_id: g.id, group: g.name, name: o.name, delta_paise: o.price_delta_paise });
  return out;
}

/** The modifiers a one-tap add carries: the defaults, or `undefined` for a dish without groups. */
export function defaultModifiers(item: Pick<MenuItem, "modifier_group_ids">): SelectedModifier[] | undefined {
  const gs = groupsFor(item);
  return gs.length ? selectedModifiers(gs, defaultSelection(gs)) : undefined;
}

export const modifiersDelta = (mods: SelectedModifier[] | undefined): string => fromMinor((mods ?? []).reduce((s, m) => s + m.delta_paise, 0));
/** "Hot, Extra butter" for the cart line and the order card. */
export const modifiersText = (mods: { name: string }[] | null | undefined): string => (mods ?? []).map((m) => m.name).join(", ");
