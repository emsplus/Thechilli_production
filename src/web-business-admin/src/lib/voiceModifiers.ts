/**
 * Spoken modifiers like a waiter hears them (owner, 2026-11-02): "ek butter chicken full, butter kam dalna" -> Butter Chicken,
 * Full, note "less butter". Hinglish / Hindi / English cue + ingredient phrases are rewritten into the plain English phrases
 * the order parser already turns into a line's note ("less butter", "extra spicy", "no onion"), and a comma before them is
 * dropped so they stay on the dish they follow. Never swallows a real dish: an ingredient followed by a word that, with it,
 * starts a dish name ("butter naan") is left alone, and nothing changes without a cue word (kam / less / zyada / extra /
 * bina / no / without / nahi). Pure; unit-tested in voiceModifiers.test.ts (40+ spoken examples).
 */
import { toLatin } from "./voiceLexicon";

/** Ingredient words (Hinglish / English) -> the English word on the kitchen ticket. */
const INGREDIENT: Record<string, string> = {
  // Latin and the Devanagari spellings as the shared transliteration writes them (pyaaj, teekhaa, lahasun ...)
  butter: "butter", makhan: "butter", makkhan: "butter", makkhana: "butter", cheese: "cheese", oil: "oil", tel: "oil",
  onion: "onion", onions: "onion", pyaaz: "onion", pyaz: "onion", pyaj: "onion", pyaaj: "onion", piyaz: "onion", piyaaj: "onion", kanda: "onion",
  garlic: "garlic", lehsun: "garlic", lahsun: "garlic", lahasun: "garlic", lasun: "garlic", ginger: "ginger", adrak: "ginger",
  salt: "salt", namak: "salt", sugar: "sugar", cheeni: "sugar", cheenee: "sugar", chini: "sugar", shakkar: "sugar",
  spicy: "spicy", spice: "spicy", teekha: "spicy", teekhaa: "spicy", tikha: "spicy", tikhaa: "spicy", teekhi: "spicy", mirchi: "spicy", mirchee: "spicy", mirch: "spicy", chilli: "spicy",
  sweet: "sweet", meetha: "sweet", meethaa: "sweet", mitha: "sweet", gravy: "gravy", rasa: "gravy", cream: "cream", malai: "cream", ghee: "ghee",
  masala: "masala", coriander: "coriander", dhaniya: "coriander", ice: "ice", baraf: "ice", barf: "ice",
};
const ING = Object.keys(INGREDIENT).sort((a, b) => b.length - a.length).join("|");
const LESS = "(?:thoda\\s+)?(?:kam|kum|less|light|halka|halki)";
const MORE = "(?:zyada|zyaada|zyaadaa|jyada|jyaadaa|jada|extra|more|double)";
const NO = "(?:bina|binaa|without|no|nahi|nahin|naheen|mat|bilkul\\s+nahi)";
const VERB = "(?:\\s+(?:dalna|daalna|daalo|dalo|dal|daal|karna|karo|kar|rakhna|rakho|dena|do|chahiye|ke|ka|ki))*";

export interface ModMenu { names: string[] }

/** Rewrites spoken modifiers into the parser's note phrases. `menu.names`: dish names (lower case) that must never be eaten. */
export function normalizeModifiers(text: string, menu: ModMenu): string {
  let t = toLatin(text);
  const dishAfter = (ing: string, rest: string) => {
    const next = rest.trimStart().split(/[\s,.;]+/)[0]?.toLowerCase() ?? "";
    return !!next && menu.names.some((n) => n.startsWith(`${ing.toLowerCase()} ${next}`));
  };
  // the ingredient word is the end of the dish just said ("matar paneer extra spicy": paneer is the dish, not a modifier)
  const dishBefore = (ing: string, before: string) => {
    const prev = before.trimEnd().split(/[\s,.;]+/).pop()?.toLowerCase() ?? "";
    return !!prev && menu.names.some((n) => n.endsWith(`${prev} ${ing.toLowerCase()}`) || n === ing.toLowerCase());
  };
  const canon = (w: string) => INGREDIENT[w.toLowerCase()] ?? w.toLowerCase();
  const rule = (re: RegExp, word: (ing: string) => string) => {
    t = t.replace(re, (m: string, ing: string, offset: number, all: string) => {
      const after = all.slice(offset + m.length);
      const ingAtStart = m.trimStart().toLowerCase().startsWith(ing.toLowerCase());
      if (dishAfter(ing, after) || (ingAtStart && dishBefore(ing, all.slice(0, offset)))) return m;
      return ` ${word(canon(ing))} `;
    });
  };
  // "kam teekha" / "thoda kam teekha" / "teekha kam" -> "less spicy"; "mild" stays as it is
  rule(new RegExp(`\\b${LESS}\\s+(${ING})\\b${VERB}`, "gi"), (i) => `less ${i}`);
  rule(new RegExp(`\\b(${ING})\\s+${LESS}\\b${VERB}`, "gi"), (i) => `less ${i}`);
  rule(new RegExp(`\\b${MORE}\\s+(${ING})\\b${VERB}`, "gi"), (i) => (i === "spicy" ? "extra spicy" : `extra ${i}`));
  rule(new RegExp(`\\b(${ING})\\s+${MORE}\\b${VERB}`, "gi"), (i) => (i === "spicy" ? "extra spicy" : `extra ${i}`));
  rule(new RegExp(`\\b${NO}\\s+(${ING})\\b${VERB}`, "gi"), (i) => `no ${i}`);
  rule(new RegExp(`\\b(${ING})\\s+(?:nahi|nahin|naheen|mat|na)\\b${VERB}`, "gi"), (i) => `no ${i}`);
  // separate packing: the shared lexicon's own phrase ("packing alag" -> note "pack separately"), never the takeaway type
  t = t.replace(/\balag\s+(?:se\s+)?(?:packing|pack|parcel)\b(?:\s+(?:karna|karo|kar|dena|do))*/gi, " alag se ").replace(/\b(?:packing|parcel)\s+alag(?:\s+se)?\b(?:\s+(?:karna|karo|kar|dena|do))*/gi, " alag se ");
  // the modifier belongs to the dish before it: no comma in between
  t = t.replace(/,\s*(?=(?:less|extra|no|alag se|mild|jain)\b)/gi, " ");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
}
