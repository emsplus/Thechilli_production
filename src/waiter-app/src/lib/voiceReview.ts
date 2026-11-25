import { makeLine, type CartLine } from "./cart";
import type { MenuItem } from "./types";
import type { VoiceClarificationOption, VoiceOrderResponse } from "./voice";

/**
 * Pure review logic for the voice sheet. Server output is untrusted for display only: every item is re-resolved
 * against the local menu snapshot, a dish that is missing/archived is dropped from confirmable lines, and a dish
 * with options (variants) never gets a silent default. Prices come from the local menu via makeLine, never from voice.
 */
export const MAX_QTY = 99;
export const LOW_CONFIDENCE = 0.6;
/** Server confidence at or above this is trusted when the heard dish name differs from the matched dish ("high"); below it the line is flagged "Check this dish". */
export const HIGH_CONFIDENCE = 0.9;

export interface ReviewLine {
  id: string; item: MenuItem | null; itemName: string; variantId: string | null; quantity: number; note: string; heard: string; issues: string[]; included: boolean;
  /** Every distinct phrase heard for this line (a merged line keeps all of them). */
  heardAll: string[];
  /** The dish heard is not the dish matched and the server was not sure: show "Check this dish". */
  checkDish: boolean;
}
export interface ReviewClar { id: string; heard: string; quantity: number; note: string; options: (VoiceClarificationOption & { item: MenuItem })[] }
export interface Review { transcript: string | null; lines: ReviewLine[]; clars: ReviewClar[]; unmatched: string[] }

const clampQty = (n: number) => Math.max(1, Math.min(MAX_QTY, Math.round(Number.isFinite(n) ? n : 1)));
const live = (items: MenuItem[]) => new Map(items.filter((i) => i.is_active).map((i) => [i.id, i]));

const NOISE = new Set(["a", "an", "one", "two", "three", "four", "five", "ek", "do", "teen", "char", "paanch", "panch", "half", "full", "regular", "large", "small", "aadha", "adha", "poora", "plate", "plates", "please", "of", "and", "aur", "ka", "ke", "ki", "wala", "wali"]);
const words = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
const LATIN = /[a-z]/;
/** The dish name inside a heard phrase: lower case, no quantity / size words, no digits, no option name, words sorted ("chicken butter" = "butter chicken"). */
function dishKey(heard: string, drop: string[] = []): string {
  const skip = new Set(drop.flatMap(words));
  return words(heard).filter((w) => !NOISE.has(w) && !/^\d+$/.test(w) && !skip.has(w)).sort().join(" ");
}
/** True when the heard phrase names a different dish than the matched one (e.g. heard "Chicken Butter Masala", matched "Butter Chicken"). Phrases in another script cannot be compared: false. */
export function heardDiffers(heard: string, itemName: string, variantName?: string | null): boolean {
  const h = dishKey(heard, variantName ? [variantName] : []);
  const n = dishKey(itemName);
  if (!h || !LATIN.test(h) || !LATIN.test(n)) return false;
  if (h === n) return false;
  const have = new Set(n.split(" "));
  return !h.split(" ").every((w) => have.has(w)); // a shortened name ("chai" for "Masala Chai") is the same dish; a word the dish does not have is a different one
}
/** The heard texts to show under the dish name: nothing when what was heard is the dish itself, otherwise every distinct phrase. */
export const heardToShow = (l: ReviewLine): string[] => (l.item && l.heardAll.some((h) => heardDiffers(h, l.itemName, l.item ? l.item.variants.find((v) => v.id === l.variantId)?.name : null)) ? l.heardAll : []);

const addHeard = (all: string[], more: string[]) => {
  const seen = new Set(all.map((h) => dishKey(h) || h.trim().toLowerCase()));
  const out = [...all];
  for (const h of more) { const k = dishKey(h) || h.trim().toLowerCase(); if (h.trim() && !seen.has(k)) { seen.add(k); out.push(h.trim()); } }
  return out;
};

/** The same dish with the same size and the same note said twice ("butter chicken half ... butter chicken half") is ONE line with the quantity added up. Different size or note, or a dish the menu no longer has, stays separate. */
export function mergeSameLines(lines: ReviewLine[]): ReviewLine[] {
  const out: ReviewLine[] = [];
  const at = new Map<string, number>();
  for (const l of lines) {
    if (!l.item) { out.push(l); continue; }
    const key = `${l.item.id}|${l.variantId ?? ""}|${l.note.trim().toLowerCase()}`;
    const i = at.get(key);
    if (i === undefined) { at.set(key, out.length); out.push(l); continue; }
    const first = out[i];
    out[i] = { ...first, quantity: clampQty(first.quantity + l.quantity), issues: Array.from(new Set([...first.issues, ...l.issues])), included: first.included || l.included,
      heardAll: addHeard(first.heardAll, l.heardAll), checkDish: first.checkDish || l.checkDish };
  }
  return out;
}

export function buildReview(resp: VoiceOrderResponse, items: MenuItem[]): Review {
  const menu = live(items);
  const unmatched = [...(resp.unmatched ?? [])];
  const lines: ReviewLine[] = (resp.lines ?? []).map((l, n) => {
    const item = menu.get(l.item_id) ?? null;
    const issues = [...(l.issues ?? [])];
    if (!item) issues.push("stale");
    else if (l.confidence < LOW_CONFIDENCE && !issues.includes("low_confidence")) issues.push("low_confidence");
    else if (l.needs_review && !issues.length) issues.push("needs_review");
    // the dish heard is not the dish matched ("Chicken Butter Masala" -> Butter Chicken) and the server is not sure: never look like an exact match
    const checkDish = !!item && l.confidence < HIGH_CONFIDENCE && heardDiffers(l.heard_text ?? "", item.name, l.variant_name);
    if (checkDish && !issues.includes("low_confidence") && !issues.includes("needs_review")) issues.push("needs_review");
    return {
      id: `l${n}`, item, itemName: item?.name ?? l.item_name, quantity: clampQty(l.quantity), note: (l.note ?? "").trim(), heard: l.heard_text,
      variantId: item && l.variant_id && item.variants.some((v) => v.id === l.variant_id) ? l.variant_id : null,
      issues, included: !!item, heardAll: addHeard([], [l.heard_text ?? ""]), checkDish,
    };
  });
  const clars: ReviewClar[] = [];
  for (const c of resp.clarifications ?? []) {
    const options = c.options.flatMap((o) => { const item = menu.get(o.item_id); return item ? [{ ...o, item }] : []; });
    if (options.length) clars.push({ id: c.id, heard: c.heard_text, quantity: clampQty(c.quantity), note: (c.note ?? "").trim(), options });
    else unmatched.push(c.heard_text);
  }
  return { transcript: resp.transcript, lines: mergeSameLines(lines), clars, unmatched };
}

/** One-tap clarification: turns the chosen candidate into a normal line (still unconfirmed). Unknown ids are a no-op. */
export function resolveClarification(r: Review, clarId: string, optionIndex: number): Review {
  const c = r.clars.find((x) => x.id === clarId);
  const o = c?.options[optionIndex];
  if (!c || !o) return r;
  const variantId = o.variant_id && o.item.variants.some((v) => v.id === o.variant_id) ? o.variant_id : null;
  const line: ReviewLine = { id: `c${c.id}`, item: o.item, itemName: o.item.name, variantId, quantity: c.quantity, note: c.note, heard: c.heard, issues: [], included: true, heardAll: [], checkDish: false };
  return { ...r, clars: r.clars.filter((x) => x.id !== clarId), lines: mergeSameLines([...r.lines, line]) };
}

const mapLine = (r: Review, id: string, f: (l: ReviewLine) => ReviewLine): Review => ({ ...r, lines: r.lines.map((l) => (l.id === id ? f(l) : l)) });
export const setQuantity = (r: Review, id: string, q: number) => mapLine(r, id, (l) => ({ ...l, quantity: clampQty(q) }));
export const setVariant = (r: Review, id: string, v: string) => mapLine(r, id, (l) => (l.item?.variants.some((x) => x.id === v) ? { ...l, variantId: v } : l));
export const setNote = (r: Review, id: string, note: string) => mapLine(r, id, (l) => ({ ...l, note: note.slice(0, 300) }));
export const removeLine = (r: Review, id: string): Review => ({ ...r, lines: r.lines.filter((l) => l.id !== id) });

export const lineNeedsVariant = (l: ReviewLine) => l.included && !!l.item && l.item.variants.length > 0 && l.variantId === null;

/** Why Confirm is disabled, or null when the waiter may confirm. */
export function blocker(r: Review): "none" | "resolve" | null {
  if (r.clars.length || r.lines.some(lineNeedsVariant)) return "resolve";
  if (!r.lines.some((l) => l.included && l.item)) return "none";
  return null;
}
export const confirmable = (r: Review) => r.lines.filter((l) => l.included && l.item).length;

/** Cart lines for a confirmed review. Pure: the caller adds them (draftActions.add merges identical lines). */
export function toCartLines(r: Review): CartLine[] {
  if (blocker(r)) return [];
  return r.lines.filter((l) => l.included && l.item).map((l) => makeLine(l.item!, l.variantId, l.quantity, l.note));
}

// ---- "done" (voiceDone.ts): add everything that is clear, keep the rest on the sheet ----
export interface DoneSplit {
  /** Lines that can go in the cart now (a dish with options and none chosen cannot). */
  cart: CartLine[];
  /** Names of the added dishes that carry a doubt (low confidence, needs review, ...): "1 to check: Lassi". */
  check: string[];
  /** The review without what was added: the unresolved lines, choices and unmatched phrases. */
  rest: Review;
  /** What is still unresolved, first one first: a dish to choose, an option to choose, a phrase not understood. */
  holds: { kind: "choose_dish" | "choose_option" | "unmatched"; heard: string; name?: string }[];
  added: number;
}
export function splitForDone(r: Review): DoneSplit {
  const ok = (l: ReviewLine) => l.included && !!l.item && !lineNeedsVariant(l);
  const addable = r.lines.filter(ok);
  const left = r.lines.filter((l) => !ok(l) && l.included && !!l.item);
  const holds: DoneSplit["holds"] = [
    ...r.clars.map((c) => ({ kind: "choose_dish" as const, heard: c.heard })),
    ...left.map((l) => ({ kind: "choose_option" as const, heard: l.heard, name: l.itemName })),
    ...r.unmatched.map((u) => ({ kind: "unmatched" as const, heard: u })),
  ];
  return {
    cart: addable.map((l) => makeLine(l.item!, l.variantId, l.quantity, l.note)),
    check: addable.filter((l) => l.issues.length).map((l) => l.itemName),
    rest: { ...r, lines: r.lines.filter((l) => !ok(l)) },
    holds, added: addable.reduce((n, l) => n + l.quantity, 0),
  };
}
