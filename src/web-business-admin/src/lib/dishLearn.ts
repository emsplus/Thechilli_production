/**
 * On-device dish learning from the owner's corrections (the wake word's auto-learn, applied to dishes): when the sheet shows a
 * phrase it could not place (or placed wrongly) and staff pick the dish, the phrase -> dish is kept on THIS device and used
 * with priority from the next order on (voiceParse buildVoiceMenu aliases: these go in after the server's, so they win).
 *
 * Text only (the normalised phrase, never audio), localStorage `pos.dishLearned.v1`, at most LEARN_MAX phrases (the oldest
 * goes), a phrase not used for EXPIRE_DAYS is dropped. No network: the server copy (PUT /menu/voice-aliases) is the existing,
 * separate path for every till, and only while online.
 */
import type { VoiceAliasIn } from "./voiceParse";

const KEY = "pos.dishLearned.v1";
export const DISH_LEARN_MAX = 200;
export const DISH_EXPIRE_DAYS = 60;
const DAY = 86_400_000;

export interface DishLesson { phrase: string; itemId: string; variantId: string | null; at: number; lastUsed: number; uses: number }

const ls = () => { try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; } };
let clock: () => number = () => Date.now();
/** Test hook. */
export function setDishLearnClock(f: () => number) { clock = f; cache = null; }

let cache: DishLesson[] | null = null;
const listeners = new Set<() => void>();

export function dishLessons(): DishLesson[] {
  if (cache) return cache;
  let list: DishLesson[] = [];
  try {
    const raw = ls()?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as { v: number; items: DishLesson[] }) : null;
    if (v?.v === 1 && Array.isArray(v.items)) list = v.items.filter((x) => typeof x?.phrase === "string" && typeof x.itemId === "string");
  } catch { /* unreadable: start empty */ }
  const t = clock();
  cache = list.filter((x) => t - (x.lastUsed ?? x.at) < DISH_EXPIRE_DAYS * DAY).slice(-DISH_LEARN_MAX);
  return cache;
}

function save(list: DishLesson[]) {
  cache = list.slice(-DISH_LEARN_MAX);
  try { ls()?.setItem(KEY, JSON.stringify({ v: 1, items: cache })); } catch { /* private mode: this page only */ }
  for (const f of listeners) f();
}

/** Phrase clean-up: lower case, single spaces, no digits (quantities are never part of a lesson), at most 80 characters. */
export const lessonPhrase = (s: string) => s.toLowerCase().replace(/\d+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** Keeps phrase -> dish (a newer choice for the same phrase replaces the old one). Returns false for an empty phrase. */
export function learnDish(phrase: string, itemId: string, variantId: string | null): boolean {
  const p = lessonPhrase(phrase);
  if (!p || p.length < 2 || !itemId) return false;
  const t = clock();
  const old = dishLessons().find((x) => x.phrase === p);
  save([...dishLessons().filter((x) => x.phrase !== p), { phrase: p, itemId, variantId, at: old?.at ?? t, lastUsed: t, uses: (old?.uses ?? 0) + 1 }]);
  return true;
}

/** A lesson that matched again: kept for another DISH_EXPIRE_DAYS (written at most once a day). */
export function touchDish(phrase: string) {
  const p = lessonPhrase(phrase), list = dishLessons(), e = list.find((x) => x.phrase === p);
  if (!e || clock() - e.lastUsed < DAY) return;
  save(list.map((x) => (x === e ? { ...x, lastUsed: clock(), uses: x.uses + 1 } : x)));
}

export function forgetDish(phrase: string) { save(dishLessons().filter((x) => x.phrase !== lessonPhrase(phrase))); }
export function forgetAllDishes() { save([]); }

/** The lessons as parser aliases, for dishes still on the menu (an archived dish's lessons wait). */
export function dishLessonAliases(itemIds?: Set<string>): VoiceAliasIn[] {
  return dishLessons().filter((x) => !itemIds || itemIds.has(x.itemId)).map((x) => ({ phrase: x.phrase, menu_item_id: x.itemId, variant_id: x.variantId }));
}

export function onDishLessons(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; }
