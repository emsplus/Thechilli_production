/**
 * The shared voice-ordering rules (voiceLexicon.json, a byte-identical copy of pos-service app/services/voice_lexicon.json,
 * made by pos-service scripts/sync_voice_fixtures.sh) as lookups, plus the small algorithms both parsers implement the same
 * way (pos-service app/services/voice_parse.py mirrors every function here; the shared corpus checks they agree):
 * Devanagari -> Latin, the sound skeleton, word similarity, the default option rule and the till-command phrases.
 */
import LEX from "./voiceLexicon.json";

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
const split = (xs: string[]) => lower(xs).map((x) => x.split(/\s+/).filter(Boolean));

export const NUM = new Map<string, number>();
for (const [k, words] of Object.entries(LEX.numbers)) {
  const [a, b] = k.split("/");
  for (const w of words) NUM.set(w, b ? Number(a) / Number(b) : Number(a));
}
export const HOMOPHONE = new Map<string, number>(Object.entries(LEX.homophone_numbers));
export const SEPARATORS = new Set(lower(LEX.separators));
export const FILLERS = new Set(lower(LEX.fillers));
export const GIVE_DO = split(LEX.give_do);
export const CORRECTIONS = split(LEX.corrections);
export const REMOVE_AFTER = split(LEX.remove_after);
export const REMOVE_BEFORE = new Set(lower(LEX.remove_before).filter((w) => !w.includes(" ")));
export const REMOVE_LAST = split(LEX.remove_last);
export const ONE_MORE = split(LEX.one_more);
export const SAME_AGAIN = split(LEX.same_again);
export const SYN = new Map<string, string>(Object.entries(LEX.synonyms));
export const PHRASE_SYN = Object.entries(LEX.phrase_synonyms).map(([k, v]) => [k.split(" "), v.split(" ")] as const)
  .sort((a, b) => b[0].length - a[0].length);
/** Spoken size word -> its canonical size ("aadha" -> "half", "bada" -> "large"). */
export const VARIANT_WORD = new Map<string, string>();
for (const [canon, words] of Object.entries(LEX.variant_words)) for (const w of words) VARIANT_WORD.set(w, canon);
export const REGULAR_WORDS = new Set(LEX.regular_words);
/** Sizes that mean "the smaller portion" / "the bigger portion" when the dish's options use other names (Half/Full vs Small/Large). */
export const SMALL_SIZES = new Set(["half", "small"]);
export const LARGE_SIZES = new Set(["full", "large"]);

const N = LEX.notes;
export const ING = new Map<string, string>();
for (const [canon, words] of Object.entries(N.ingredients)) for (const w of words) ING.set(w, canon);
export const NOTE_MORE = split(N.more), NOTE_LESS = split(N.less), NOTE_NONE = split(N.none), NOTE_NONE_AFTER = split(N.none_after);
export const SPICY = new Set(N.spicy_words), SPICY_MORE = new Set(N.spicy_more), SPICY_LESS = new Set(N.spicy_less), MILD = new Set(N.mild_words);
export const NOTE_FIXED = Object.entries(N.fixed).map(([k, v]) => [k.split(" "), v] as const).sort((a, b) => b[0].length - a[0].length);

/** Length of the longest phrase of `list` that starts at words[i] (0 = none). */
export function phraseAt(words: string[], i: number, list: readonly (readonly string[])[]): number {
  let best = 0;
  for (const p of list) if (p.length > best && p.every((w, k) => words[i + k] === w)) best = p.length;
  return best;
}

// ---------------------------------------------------------------- Devanagari -> Latin (same tables as voice_parse.py)
const CONS: Record<string, string> = {
  "\u0915": "k", "\u0916": "kh", "\u0917": "g", "\u0918": "gh", "\u0919": "n", "\u091A": "ch", "\u091B": "chh", "\u091C": "j", "\u091D": "jh", "\u091E": "n", "\u091F": "t", "\u0920": "th", "\u0921": "d",
  "\u0922": "dh", "\u0923": "n", "\u0924": "t", "\u0925": "th", "\u0926": "d", "\u0927": "dh", "\u0928": "n", "\u092A": "p", "\u092B": "ph", "\u092C": "b", "\u092D": "bh", "\u092E": "m", "\u092F": "y",
  "\u0930": "r", "\u0932": "l", "\u0935": "v", "\u0936": "sh", "\u0937": "sh", "\u0938": "s", "\u0939": "h", "\u0933": "l",
};
const VOWELS: Record<string, string> = { "\u0905": "a", "\u0906": "aa", "\u0907": "i", "\u0908": "ee", "\u0909": "u", "\u090A": "oo", "\u090B": "ri", "\u090F": "e", "\u0910": "ai", "\u0913": "o", "\u0914": "au", "\u0911": "o" };
const MATRAS: Record<string, string> = { "\u093E": "aa", "\u093F": "i", "\u0940": "ee", "\u0941": "u", "\u0942": "oo", "\u0947": "e", "\u0948": "ai", "\u094B": "o", "\u094C": "au", "\u0943": "ri", "\u0949": "o", "\u0945": "e" };
const VIRAMA = "\u094D", NUKTA = "\u093C";

function translitWord(w: string): string {
  const chars = [...w];
  let out = "";
  chars.forEach((ch, i) => {
    const nxt = chars[i + 1] ?? "";
    if (CONS[ch]) {
      out += CONS[ch];
      if (!MATRAS[nxt] && nxt !== VIRAMA && nxt !== NUKTA && i + 1 < chars.length) out += "a"; // inherent 'a' inside a word; a word-final one is silent
    } else if (MATRAS[ch]) out += MATRAS[ch];
    else if (VOWELS[ch]) out += VOWELS[ch];
    else if ("\u0902\u0901".includes(ch)) out += "n";
    else if (ch === "\u0903") out += "h";
    else if (ch !== VIRAMA && ch !== NUKTA) out += ch;
  });
  return out;
}

/** Any script's digits -> ASCII, Devanagari words -> Latin. Lengths change, so callers convert word by word. */
export function toLatin(s: string): string {
  let t = s.normalize("NFC").replace(/\p{Nd}/gu, (d) => (/[0-9]/.test(d) ? d : String(Number.parseInt(d.normalize("NFKD"), 10) || digitOf(d))));
  t = t.replace(/[\u0900-\u097F]+/g, (m) => translitWord(m.normalize("NFD").replace(/\u093C/g, "")));
  return t;
}
function digitOf(d: string): number {
  const c = d.codePointAt(0)!;
  for (const zero of [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0660, 0x06f0]) if (c >= zero && c <= zero + 9) return c - zero;
  return 0;
}

// ---------------------------------------------------------------- similarity
/** Sound skeleton: spelling variants of one Hinglish word collapse (chai/chaay, paneer/panir, dosa/dosha, lassi/lasi). */
export function skeleton(w: string): string {
  return w.replace(/ph/g, "f").replace(/ck/g, "k").replace(/([bcdgjkpstr])h/g, "$1").replace(/q/g, "k").replace(/z/g, "j")
    .replace(/w/g, "v").replace(/x/g, "ks").replace(/ee/g, "i").replace(/oo/g, "u").replace(/c/g, "k").replace(/(.)\1+/g, "$1")
    .replace(/o/g, "u").replace(/(.)\1+/g, "$1").replace(/y$/, "i");
}

export function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** 1 = same word, 0.92 = same sound, ~0.68..0.9 = near miss (edit distance on the skeleton), 0 = different. */
export function rawSim(a: string, b: string): number {
  if (a === b) return 1;
  if (/\d/.test(a + b)) return 0;
  const sa = skeleton(a), sb = skeleton(b);
  if (sa === sb) return 0.92;
  if (Math.min(sa.length, sb.length) < 3) return 0;
  const r = 1 - lev(sa, sb) / Math.max(sa.length, sb.length);
  const r2 = Math.min(a.length, b.length) >= 4 ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0;
  const best = Math.max(r, r2);
  return best >= 0.75 ? Math.round(best * 0.9 * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------- the default option
/**
 * Index of the option a dish gets when staff name none ("ek butter chicken" -> Half), or null for regular. The cheapest
 * choice wins: regular costs the menu price, an option price + price_delta; a tie between regular and an option goes to
 * the option (Half at +0 is what the kitchen should read), a tie between options to the first in menu order. The menu has
 * no per-dish default field; this rule is it (same as pos-service voice_order.default_variant).
 */
export function defaultVariantIndex(deltas: (string | number | null | undefined)[]): number | null {
  let best: number | null = null, bestDelta = Infinity;
  deltas.forEach((d, k) => { const v = Number(d ?? 0); if (v <= 0 && v < bestDelta) { best = k; bestDelta = v; } });
  return best;
}

// ---------------------------------------------------------------- till commands
const CMD = LEX.commands;
/** Spoken word -> command word ("plays" -> place, "cot" -> kot, "bhejo" -> send). Multi-word entries are matched first. */
export const CMD_WORDS: { words: string[]; canon: string }[] = Object.entries(CMD.words).filter(([k]) => k !== "_doc")
  .flatMap(([canon, ws]) => (ws as string[]).map((w) => ({ words: w.toLowerCase().split(/\s+/), canon })))
  .sort((a, b) => b.words.length - a.words.length);
export const CMD_PATTERNS: { cmd: string; seq: string[] }[] = Object.entries(CMD.patterns)
  .flatMap(([cmd, ps]) => (ps as string[][]).map((seq) => ({ cmd, seq })));
