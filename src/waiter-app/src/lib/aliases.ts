import type { MenuItem } from "./types";

/**
 * Hindi/Hinglish-aware menu search. Three layers, cheapest first:
 *  1. plain case-insensitive substring of the dish name (the original behaviour, always on);
 *  2. learnt phrases from GET /menu/voice-aliases (restaurant-specific, e.g. "pnr tikka" -> Paneer Tikka);
 *  3. a sound skeleton: Devanagari is transliterated to Latin, vowels (and y/h/w) are dropped and doubled letters
 *     collapse, so "pnir", "paneer" and "पनीर" all become "pnr"; "chai masala" matches "Masala Chai" token by token.
 * Heuristic, not a spelling corrector: it can over-match short words, and it is a search aid only (the waiter taps the dish).
 */
export interface Alias { phrase: string; menu_item_id: string; variant_id?: string | null; item_active?: boolean }

const MATRA: Record<string, string> = { "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri", "ं": "n", "ँ": "n", "ः": "h", "़": "", "ॉ": "o", "ॅ": "e" };
const VOWEL: Record<string, string> = { "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri" };
const CONS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
};
const VIRAMA = "्";

/** Devanagari -> rough Latin. Inherent 'a' follows a consonant unless a matra/virama follows or the word ends (final schwa dropped). */
export function transliterate(s: string): string {
  const cs = Array.from(s.normalize("NFC").replace(/\u093C/g, ""));
  let out = "";
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (CONS[c] !== undefined) {
      out += CONS[c];
      const n = cs[i + 1];
      if (n !== undefined && MATRA[n] === undefined && n !== VIRAMA && !/[\s,.;:!?()\-]/.test(n)) out += "a";
    } else if (VOWEL[c] !== undefined) out += VOWEL[c];
    else if (MATRA[c] !== undefined) out += MATRA[c];
    else if (c !== VIRAMA) out += c;
  }
  return out;
}

/** Lowercase, Devanagari to Latin, strip diacritics/punctuation, collapse spaces. */
export function norm(s: string): string {
  return transliterate(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
/** Sound skeleton of ONE word. */
export function skeleton(word: string): string {
  const w = norm(word).replace(/\s/g, "")
    .replace(/ph/g, "f").replace(/(.)\1+/g, "$1")
    .replace(/kh/g, "k").replace(/gh/g, "g").replace(/th/g, "t").replace(/dh/g, "d").replace(/bh/g, "b").replace(/jh/g, "j").replace(/chh/g, "ch")
    .replace(/w/g, "v").replace(/z/g, "j").replace(/q/g, "k").replace(/sh/g, "s");
  return w.replace(/[aeiouyh]/g, "").replace(/(.)\1+/g, "$1") || w;
}
/** Hindi/Hinglish kitchen words that do not sound like the English menu name. Both spellings are matched. */
const SEED: Record<string, string[]> = {
  chai: ["tea"], tea: ["chai"], paani: ["water"], pani: ["water"], doodh: ["milk"], dahi: ["curd", "raita"], roti: ["chapati", "phulka"], chapati: ["roti"],
  chawal: ["rice"], bhaat: ["rice"], sabzi: ["veg", "vegetable"], murgh: ["chicken"], murga: ["chicken"], gosht: ["mutton"], anda: ["egg"], aloo: ["potato"],
  gobhi: ["cauliflower", "gobi"], matar: ["peas"], mirch: ["chilli", "chili"], pyaz: ["onion"], mithai: ["sweet", "dessert"], meetha: ["sweet", "dessert"],
};
const SEED_N = new Map<string, string[]>(Object.entries(SEED).map(([k, v]) => [skeleton(k), v.map((x) => skeleton(x)).filter((x) => x.length >= 2)]));

const toks = (s: string) => norm(s).split(" ").filter(Boolean);

function tokenMatches(qSk: string, nameSk: string): boolean {
  if (!qSk || !nameSk) return false;
  if (qSk === nameSk) return true;
  return qSk.length >= 2 && nameSk.startsWith(qSk);
}
function queryTokenHits(q: string, nameToks: string[]): boolean {
  const qsk = skeleton(q);
  if (nameToks.some((n) => tokenMatches(qsk, skeleton(n)))) return true;
  const syn = SEED_N.get(qsk);
  return !!syn && syn.some((s) => nameToks.some((n) => skeleton(n) === s));
}

/** Items matching `query`; plain-substring hits first, then aliases, then sound matches; original order within a tier. */
export function searchItems(items: MenuItem[], query: string, aliases: Alias[] = []): MenuItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  const qn = norm(query);
  const qToks = qn.split(" ").filter(Boolean);
  const aliasIds = new Set<string>();
  if (qn) for (const a of aliases) {
    if (a.item_active === false) continue;
    const p = norm(a.phrase);
    if (p && (p === qn || p.includes(qn) || (qn.length >= 3 && qn.includes(p)))) aliasIds.add(a.menu_item_id);
  }
  const tier = (i: MenuItem): number => {
    if (i.name.toLowerCase().includes(needle)) return 0;
    if (aliasIds.has(i.id)) return 1;
    if (!qToks.length) return 9;
    const nt = toks(i.name);
    return qToks.every((q) => queryTokenHits(q, nt)) ? 2 : 9;
  };
  return items.map((i, idx) => ({ i, t: tier(i), idx })).filter((x) => x.t < 9).sort((a, b) => a.t - b.t || a.idx - b.idx).map((x) => x.i);
}
