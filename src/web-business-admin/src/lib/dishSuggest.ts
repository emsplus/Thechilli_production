/**
 * Suggested pronunciations per dish, generated on the device from the dish's English name: Devanagari (the lexicon's spelling
 * as hi-IN recognisers write it, else rule-based Latin -> Devanagari), Hinglish spellings (the lexicon's other spellings) and
 * other names of the dish (lexicon phrases, "golgappe" for Pani Puri). The parser already understands every one of them
 * through the phonetic key and the lexicon (dishMatch.test.ts checks each suggestion resolves to its own dish), so they work
 * at once; the owner can accept one into the restaurant's learnt phrases (PUT /menu/voice-aliases, every till), edit it, or
 * delete it from the list (hidden on this device).
 *
 * Cached in localStorage per menu (`pos.dishSuggest.v1`, keyed by a hash of the dish ids and names): generated again when the
 * menu changes. Text only, no network.
 */
import LEX from "./foodLexicon.json";
import { devanagariOf, LEXICON, lexWord } from "./dishLexicon";

export interface Suggestion { text: string; kind: "devanagari" | "hinglish" | "other" }
interface Dish { id: string; name: string }

const PHRASES = (LEX as unknown as { phrases: { to: string; forms: string[] }[] }).phrases;
const ls = () => { try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; } };
const CACHE = "pos.dishSuggest.v1", HIDDEN = "pos.dishSuggestHidden.v1";
export const SUGGEST_MAX = 6;

/** The dish's spoken words: no bracketed part ("(2 pcs)"), no numbers-only words, no "and". */
const nameWords = (name: string) => name.replace(/\([^)]*\)/g, " ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "and");

/** Suggestions for one dish (at most SUGGEST_MAX, no duplicates, never the plain English name itself). */
export function suggestFor(name: string): Suggestion[] {
  const words = nameWords(name);
  if (!words.length) return [];
  const out: Suggestion[] = [];
  const seen = new Set([words.join(" ")]);
  const add = (text: string, kind: Suggestion["kind"]) => { const t = text.trim(); if (t && !seen.has(t)) { seen.add(t); out.push({ text: t, kind }); } };
  // Devanagari: first and (when the lexicon has one) second spelling of each word
  // a word the lexicon reads as ANOTHER word ("pani" in Pani Puri is water on its own) keeps its own spelling
  const own = (w: string) => lexWord(w, false) === w;
  const dev = words.map((w) => (/^\d+$/.test(w) ? [w] : devanagariOf(w, !own(w))));
  if (dev.every((d) => d.length)) {
    add(dev.map((d) => d[0]).join(" "), "devanagari");
    if (dev.some((d) => d.length > 1)) add(dev.map((d) => d[1] ?? d[0]).join(" "), "devanagari");
  }
  // Hinglish: the lexicon's other Latin spellings, one word changed at a time, then all at once
  const spell = words.map((w) => (own(w) ? LEXICON.get(w)?.latin ?? [] : []).filter((x) => x !== w && !/\s/.test(x)));
  for (let i = 0; i < words.length && out.length < SUGGEST_MAX - 1; i++) if (spell[i][0]) add(words.map((w, k) => (k === i ? spell[i][0] : w)).join(" "), "hinglish");
  if (spell.some((s) => s.length > 1)) add(words.map((w, k) => spell[k][1] ?? spell[k][0] ?? w).join(" "), "hinglish");
  // other names of this dish
  const key = words.join(" ");
  for (const p of PHRASES) if (p.to === key || key.endsWith(` ${p.to}`) && p.to.split(" ").length >= 2) for (const f of p.forms) if (out.length < SUGGEST_MAX + 2) add(f.toLowerCase(), "other");
  return out.slice(0, SUGGEST_MAX);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Suggestions for every dish, from the device cache while the menu is unchanged, else generated (and cached) now. */
export function menuSuggestions(dishes: Dish[]): Map<string, Suggestion[]> {
  const h = hash(dishes.map((d) => `${d.id}:${d.name}`).sort().join("|"));
  try {
    const raw = ls()?.getItem(CACHE);
    const c = raw ? (JSON.parse(raw) as { h: string; v: Record<string, Suggestion[]> }) : null;
    if (c?.h === h) return new Map(Object.entries(c.v));
  } catch { /* regenerate */ }
  const m = new Map(dishes.map((d) => [d.id, suggestFor(d.name)]));
  try { ls()?.setItem(CACHE, JSON.stringify({ h, v: Object.fromEntries(m) })); } catch { /* private mode: not cached */ }
  return m;
}

/** Suggestions the owner deleted (or accepted) on this device: `${dishId}|${text}`. */
export function hiddenSuggestions(): Set<string> {
  try { return new Set(JSON.parse(ls()?.getItem(HIDDEN) ?? "[]") as string[]); } catch { return new Set(); }
}
export function hideSuggestion(dishId: string, text: string) {
  const s = hiddenSuggestions();
  s.add(`${dishId}|${text}`);
  try { ls()?.setItem(HIDDEN, JSON.stringify([...s].slice(-2000))); } catch { /* this page only */ }
}
