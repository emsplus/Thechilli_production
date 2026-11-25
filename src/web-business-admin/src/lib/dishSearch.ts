/**
 * Counter dish search that finds what staff actually type (C-15): Hinglish spellings ("panir", "biriyani", "chiken"),
 * Hindi typed in Devanagari script, English words for Indian dishes ("tea" -> chai) and short codes ("bc" -> Butter Chicken).
 * The word similarity is the voice parser's (`skeleton` / `wordSim` from voiceParse.ts), so search and voice agree;
 * the small alias table below is search-only (the voice parser keeps its own synonym table: duplication noted on purpose,
 * the voice module does not export it).
 */
import { skeleton, wordSim } from "./voiceParse";

/** Devanagari and English words -> the Latin spelling menus use. */
const ALIAS: Record<string, string> = {
  // Devanagari (escaped: the English-only gate keeps Hindi script out of source files; this is search input, not UI text)
  "\u092a\u0928\u0940\u0930": "paneer", "\u092c\u093f\u0930\u092f\u093e\u0928\u0940": "biryani", "\u092c\u093f\u0930\u093f\u092f\u093e\u0928\u0940": "biryani", "\u091a\u093e\u092f": "chai", "\u0928\u093e\u0928": "naan", "\u0930\u094b\u091f\u0940": "roti", "\u0926\u093e\u0932": "dal",
  "\u092e\u0915\u094d\u0916\u0928\u0940": "makhani", "\u092e\u0916\u0928\u0940": "makhani", "\u092c\u091f\u0930": "butter", "\u091a\u093f\u0915\u0928": "chicken", "\u092e\u091f\u0928": "mutton", "\u0932\u0938\u094d\u0938\u0940": "lassi", "\u0915\u0949\u092b\u0940": "coffee",
  "\u0915\u0949\u092b\u093c\u0940": "coffee", "\u0921\u094b\u0938\u093e": "dosa", "\u0938\u092e\u094b\u0938\u093e": "samosa", "\u092a\u0930\u093e\u0920\u093e": "paratha", "\u0917\u093e\u0930\u094d\u0932\u093f\u0915": "garlic", "\u0924\u0902\u0926\u0942\u0930\u0940": "tandoori", "\u091f\u093f\u0915\u094d\u0915\u093e": "tikka",
  "\u091c\u0940\u0930\u093e": "jeera", "\u0930\u093e\u0907\u0938": "rice", "\u091a\u093e\u0935\u0932": "rice", "\u092a\u0941\u0932\u093e\u0935": "pulao", "\u0906\u0932\u0942": "aloo", "\u0917\u094b\u092d\u0940": "gobi", "\u092e\u091f\u0930": "matar", "\u091b\u094b\u0932\u0947": "chole",
  "\u0915\u092c\u093e\u092c": "kebab", "\u0930\u093e\u092f\u0924\u093e": "raita", "\u092a\u093e\u092a\u0921\u093c": "papad", "\u0917\u0941\u0932\u093e\u092c": "gulab", "\u091c\u093e\u092e\u0941\u0928": "jamun", "\u0915\u0941\u0932\u094d\u092b\u0940": "kulfi", "\u092e\u0938\u093e\u0932\u093e": "masala",
  "\u092a\u093e\u0932\u0915": "palak", "\u0915\u0922\u093c\u093e\u0908": "kadai", "\u0915\u094b\u0930\u092e\u093e": "korma", "\u0925\u093e\u0932\u0940": "thali", "\u092a\u093e\u0928\u0940": "water", "\u0928\u0940\u0902\u092c\u0942": "nimbu",
  // English / spelling variants
  tea: "chai", chay: "chai", biriyani: "biryani", briyani: "biryani", biriani: "biryani", panir: "paneer", nan: "naan",
  chiken: "chicken", chikan: "chicken", murgh: "chicken", murg: "chicken", daal: "dal", dhal: "dal", kadhai: "kadai", karahi: "kadai",
  parantha: "paratha", prata: "paratha", rice: "rice", chawal: "rice", curd: "dahi", yogurt: "dahi", lemon: "nimbu", coffe: "coffee",
};

const strip = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Latin words of a text, each through the alias table (Devanagari words are kept whole so the table can find them). */
export function searchWords(text: string): string[] {
  return strip(text).split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean).map((w) => ALIAS[w] ?? w);
}

/** How well a query word fits a name word: prefix, same sound, or a near miss (0 = no). */
function fit(q: string, w: string): number {
  if (w === q) return 1;
  if (q.length >= 2 && w.startsWith(q)) return 0.95;
  if (q.length < 3) return 0;
  if (skeleton(w).startsWith(skeleton(q)) && q.length >= 3) return 0.9;
  return wordSim(q, w);
}

/**
 * Score of a dish name for a query (0 = no match). Every query word must fit some word of the name (fuzzy), or the query
 * is the dish's initials ("bc" -> Butter Chicken, "gn" -> Garlic Naan).
 */
export function dishScore(name: string, query: string): number {
  const q = searchWords(query);
  if (!q.length) return 0;
  const words = searchWords(name);
  const raw = strip(name);
  if (raw.includes(strip(query).trim())) return 1;
  const compact = q.join("");
  if (q.length === 1 && compact.length >= 2 && compact.length <= 4 && words.length >= compact.length) {
    if (words.map((w) => w[0]).join("").startsWith(compact)) return 0.85;
  }
  let total = 0;
  for (const qw of q) {
    let best = 0;
    for (const w of words) best = Math.max(best, fit(qw, w));
    if (best < 0.68) return 0;
    total += best;
  }
  return total / q.length;
}

/** Dishes matching the query, best first (stable for equal scores). */
export function searchDishes<T extends { name: string }>(items: T[], query: string): T[] {
  if (!query.trim()) return items;
  return items.map((it, i) => ({ it, i, s: dishScore(it.name, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}
