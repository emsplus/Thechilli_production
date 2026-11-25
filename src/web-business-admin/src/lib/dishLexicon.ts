/**
 * Dish words as the recogniser writes them: the phonetic key (the wake word's approach, wakeWord.ts phoneticKey, extended for
 * food words), the Hinglish / Hindi food lexicon (foodLexicon.json) and Latin -> Devanagari for suggested pronunciations.
 * Pure, on-device, text only.
 *
 * foodKey: one letter per sound class, so spellings of one word meet:
 *   vowels in three classes, one letter per run of a class: a/aa -> A, e/i/ee (and y inside a word) -> I, o/u/oo -> U
 *   ("paneer"/"panir" -> PANIR, "biriyani"/"biryani" -> BIRIANI, "roti"/"rotee" -> RUTI; "raita" RAITA stays apart)
 *   aspiration goes (kh gh chh jh th dh ph bh -> K G C J T D F B), doubled letters collapse ("tikka"/"tika" -> TAKA)
 *   ch -> C, c/k/q/ck -> K (c before e/i -> S), z -> J ("zeera"/"jeera"), sh/s -> S, v/w -> V, ph/f -> F, x -> KS
 *   n / m before a consonant (a nasal) goes ("tandoori"/"tanduri" -> TADARA)
 * keyDistance: edit distance on keys where the common slips cost half: a vowel more or less (a schwa the transliteration
 * kept, a final a/e/i), one vowel class for another (a/e/i/o/u confusions), t~d, d~r (the flapped retroflex r), k~g, p~b, b~v, s~j, c~j.
 */
import LEX from "./foodLexicon.json";
import { FILLERS, toLatin } from "./voiceLexicon";

const clean = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

const keyMemo = new Map<string, string>();
/** Phonetic key of one (Latin or Devanagari) word; "" for nothing. Memoised (the live transcript repeats its words). */
export function foodKey(word: string): string {
  let k = keyMemo.get(word);
  if (k === undefined) {
    if (keyMemo.size > 20_000) keyMemo.clear();
    keyMemo.set(word, (k = computeKey(word)));
  }
  return k;
}

function computeKey(word: string): string {
  let w = clean(/[\u0900-\u097F]/.test(word) ? toLatin(word) : word);
  if (!w) return "";
  w = w.replace(/ck/g, "k").replace(/chh/g, "C").replace(/ch/g, "C").replace(/sh/g, "S").replace(/ph/g, "f").replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s").replace(/q/g, "k").replace(/c/g, "k").replace(/z/g, "j").replace(/([kgjtdpb])h/g, "$1");
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i], next = w[i + 1] ?? "";
    let k: string;
    if (c === "a") k = "A";
    else if (/[ei]/.test(c) || (c === "y" && i > 0)) k = "I";
    else if (/[ou]/.test(c)) k = "U";
    else if (c === "y") k = "Y";
    else if (c === "h") k = i === 0 ? "H" : ""; // "dahi", "chai": a breath inside a word is no sound class
    else if ((c === "n" || c === "m") && next && !/[aeiouyh]/.test(next) && i > 0) k = ""; // a nasal before a consonant
    else if (c === "w" || c === "v") k = "V";
    else if (c === "S") k = "S";
    else if (c === "C") k = "C";
    else k = c.toUpperCase();
    if (k && out[out.length - 1] !== k) out += k;
  }
  return out;
}

const CHEAP = new Set(["TD", "DT", "DR", "RD", "KG", "GK", "PB", "BP", "BV", "VB", "SJ", "JS", "CJ", "JC", "FP", "PF", "LR", "RL"]);
/** Weighted edit distance between two keys (vowel in/out and the cheap pairs cost 0.5). */
export function keyDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const vowel = (c: string) => c === "A" || c === "I" || c === "U";
  const ins = (c: string) => (vowel(c) ? 0.5 : 1);
  let prev = new Array<number>(n + 1);
  prev[0] = 0;
  for (let j = 1; j <= n; j++) prev[j] = prev[j - 1] + ins(b[j - 1]);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = prev[0] + ins(a[i - 1]);
    for (let j = 1; j <= n; j++) {
      const x = a[i - 1], y = b[j - 1];
      const sub = x === y ? 0 : CHEAP.has(x + y) || (vowel(x) && vowel(y)) ? 0.5 : 1;
      cur[j] = Math.min(prev[j] + ins(x), cur[j - 1] + ins(y), prev[j - 1] + sub);
    }
    prev = cur;
  }
  return prev[n];
}

/** How far two keys may be apart, by the shorter one's length: short words must (nearly) match. */
export function keyAllowance(len: number): number {
  return len <= 4 ? 0.5 : len <= 7 ? 1 : 1.5;
}

/**
 * 0.9 = same phonetic key, ~0.76..0.84 = within the allowance for the length (same first sound class), 0 = different.
 * Numbers and words shorter than 3 letters never match by sound.
 */
export function phoneticSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3 || /\d/.test(a + b)) return 0;
  const ka = foodKey(a), kb = foodKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 0.9;
  const v0 = (c: string) => c === "A" || c === "I" || c === "U";
  const first = ka[0] === kb[0] || CHEAP.has(ka[0] + kb[0]) || (v0(ka[0]) && v0(kb[0]));
  if (!first) return 0;
  const d = keyDistance(ka, kb);
  const allow = keyAllowance(Math.min(ka.length, kb.length));
  return d <= allow ? Math.round((0.86 - 0.08 * d) * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------- the lexicon
interface LexWord { w: string; kind: string; latin: string[]; hi: string[] }
interface LexPhrase { to: string; forms: string[] }
const WORDS = (LEX as unknown as { words: LexWord[] }).words;
const PHRASES = (LEX as unknown as { phrases: LexPhrase[] }).phrases;

/** Lexicon entries by canonical word (for suggestions). */
export const LEXICON = new Map<string, LexWord>(WORDS.map((e) => [e.w, e]));

/** Exact spelling (Latin, or Devanagari transliterated) -> canonical word; null when two entries claim it. */
const EXACT = new Map<string, string | null>();
/** Phonetic key -> canonical word; null when two entries share the key (then only exact spellings count). */
const BY_KEY = new Map<string, string | null>();
const claim = (m: Map<string, string | null>, k: string, w: string) => {
  if (!k) return;
  const had = m.get(k);
  m.set(k, had === undefined || had === w ? w : null);
};
for (const e of WORDS) {
  if (e.kind === "qty") continue; // quantities are read by the order parser itself (voiceLexicon.json numbers)
  for (const s of [e.w, ...e.latin]) if (!s.includes(" ")) claim(EXACT, s.toLowerCase(), e.w);
  for (const h of e.hi) if (!h.includes(" ")) claim(EXACT, clean(toLatin(h)), e.w);
  for (const s of [e.w, ...e.latin, ...e.hi.filter((h) => !h.includes(" "))]) claim(BY_KEY, foodKey(s), e.w);
}
/** Lexicon words that are sizes ("bada" -> large): the order parser reads them as option words. */
export const LEX_SIZE = new Set(WORDS.filter((e) => e.kind === "size").map((e) => e.w));

/**
 * The canonical word for a spelling: an exact lexicon spelling, else (`fuzzy`) one lexicon word with the same phonetic key.
 * Returns the word itself when nothing fits.
 */
export function lexWord(w: string, fuzzy = true): string {
  const s = clean(w);
  if (!s) return w;
  const e = EXACT.get(s);
  if (e) return e;
  if (e === null || !fuzzy || s.length < 3) return w;
  const k = BY_KEY.get(foodKey(s));
  return k ?? w;
}

/** Other names of a dish, as key sequences: "golgappe" (Latin or Devanagari) -> "pani puri", "murgh makhani" -> "butter chicken". */
const PHRASE_KEYS: { keys: string[]; joined: string; to: string[] }[] = [];
for (const p of PHRASES) for (const f of p.forms) {
  const ws = toLatin(f).toLowerCase().split(/[^a-z]+/).filter((w) => w && !FILLERS.has(w)); // "maa ki dal": the parser drops "ki" first
  const keys = ws.map(foodKey);
  if (keys.every(Boolean)) PHRASE_KEYS.push({ keys, joined: keys.join(""), to: p.to.split(" ") });
}
PHRASE_KEYS.sort((a, b) => b.keys.length - a.keys.length);

/**
 * Other names of a dish replaced by the menu's words ("golgappe" -> "pani puri", "jeera chawal" -> "jeera rice"), matched
 * on phonetic keys word by word (or one word run together: "gulaabajaamun"). Longest first; never across the phrase.
 */
export function lexPhrases(words: string[]): string[] {
  if (!words.length) return words;
  const memoKey = words.join(" ");
  const had = phraseMemo.get(memoKey);
  if (had) return had;
  const keys = words.map(foodKey);
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    let hit: { len: number; to: string[] } | null = null;
    for (const p of BY_FIRST.get(keys[i]) ?? []) {
      const n = p.keys.length;
      if (i + n <= words.length && p.keys.every((k, j) => k === keys[i + j])) { hit = { len: n, to: p.to }; break; }
    }
    if (!hit && keys[i].length >= 6) { // one word run together ("gulaabajaamun"): only multi-word forms of about that length
      for (const p of RUN_TOGETHER) {
        if (Math.abs(p.joined.length - keys[i].length) <= 1 && p.joined[0] === keys[i][0] && keyDistance(keys[i], p.joined) <= 0.5) { hit = { len: 1, to: p.to }; break; }
      }
    }
    if (hit) { out.push(...hit.to); i += hit.len; } else out.push(words[i++]);
  }
  if (phraseMemo.size > 5000) phraseMemo.clear();
  phraseMemo.set(memoKey, out);
  return out;
}
const phraseMemo = new Map<string, string[]>();
/** Phrase forms by their first word's key (longest first), and the multi-word ones for the run-together check. */
const BY_FIRST = new Map<string, typeof PHRASE_KEYS>();
for (const p of PHRASE_KEYS) { const l = BY_FIRST.get(p.keys[0]) ?? []; l.push(p); BY_FIRST.set(p.keys[0], l); }
const RUN_TOGETHER = PHRASE_KEYS.filter((p) => p.keys.length > 1);

// ---------------------------------------------------------------- Latin -> Devanagari (suggested pronunciations)
const V_INIT: [string, string][] = [["aa", "\u0906"], ["ai", "\u0910"], ["au", "\u0914"], ["ee", "\u0908"], ["oo", "\u090A"], ["a", "\u0905"], ["i", "\u0907"], ["u", "\u0909"], ["e", "\u090F"], ["o", "\u0913"]];
const V_MATRA: [string, string][] = [["aa", "\u093E"], ["ai", "\u0948"], ["au", "\u094C"], ["ee", "\u0940"], ["oo", "\u0942"], ["a", ""], ["i", "\u093F"], ["u", "\u0941"], ["e", "\u0947"], ["o", "\u094B"]];
const C_MAP: [string, string][] = [
  ["chh", "\u091B"], ["kh", "\u0916"], ["gh", "\u0918"], ["ch", "\u091A"], ["jh", "\u091D"], ["th", "\u0925"], ["dh", "\u0927"], ["ph", "\u092B"], ["bh", "\u092D"], ["sh", "\u0936"],
  ["k", "\u0915"], ["g", "\u0917"], ["c", "\u0915"], ["j", "\u091C"], ["t", "\u091F"], ["d", "\u0921"], ["n", "\u0928"], ["p", "\u092A"], ["b", "\u092C"], ["m", "\u092E"], ["y", "\u092F"],
  ["r", "\u0930"], ["l", "\u0932"], ["v", "\u0935"], ["w", "\u0935"], ["s", "\u0938"], ["h", "\u0939"], ["f", "\u092B\u093C"], ["z", "\u091C\u093C"], ["q", "\u0915\u093C"], ["x", "\u0915\u094D\u0938"],
];
const VIRAMA = "\u094D";

/** A Latin (Hinglish) word written in Devanagari, the way hi-IN recognisers spell it ("tandoori" -> ta-n-doo-ree in Devanagari letters). Rule based. */
export function toDevanagari(word: string): string {
  const w = clean(word);
  let out = "", i = 0, afterCons = false;
  const take = (list: [string, string][]) => { for (const [l, d] of list) if (w.startsWith(l, i)) { i += l.length; return d; } return null; };
  while (i < w.length) {
    if (/[aeiou]/.test(w[i])) {
      // "ee" at the end of a word, "i" at the end: the long ee matra the recognisers write ("roti" ends in the long ee)
      const endI = i === w.length - 1 && w[i] === "i", endA = i === w.length - 1 && w[i] === "a";
      const v = afterCons ? take(V_MATRA) : take(V_INIT);
      out += endI && afterCons ? "\u0940" : endA && afterCons ? "\u093E" : v ?? ""; // a final i / a is long: roti, ka
      afterCons = false;
      continue;
    }
    // doubled consonant: half letter + letter ("tikka": half k + k)
    if (i + 1 < w.length && w[i] === w[i + 1] && !/[aeiouh]/.test(w[i])) {
      const d = C_MAP.find(([l]) => l === w[i]);
      if (d) { if (afterCons) out += VIRAMA; out += d[1] + VIRAMA; i++; afterCons = false; }
    }
    if (w[i] === "n" && afterCons === false && i > 0 && i + 1 < w.length && !/[aeiouy]/.test(w[i + 1])) { out += "\u0902"; i++; continue; } // a nasal: "tandoori" gets the anusvara
    const c = take(C_MAP);
    if (!c) { i++; continue; }
    if (afterCons) out += VIRAMA;
    out += c;
    afterCons = true;
  }
  return out;
}

/**
 * Devanagari spellings of a word: the lexicon's (as recognisers write them), the ones that sound like the word first ("pani"
 * -> paanee before "vaatar"); `sameSound` keeps only those (else the rule-based spelling).
 */
export function devanagariOf(word: string, sameSound = false): string[] {
  const e = LEXICON.get(lexWord(word, false));
  const k = foodKey(word);
  const forms = (e?.hi ?? []).filter((h) => !h.includes(" "));
  const near = forms.filter((h) => keyDistance(foodKey(h), k) <= 0.5);
  const list = sameSound ? near : [...near, ...forms.filter((h) => !near.includes(h))];
  if (list.length) return list.slice(0, 2);
  const t = toDevanagari(word);
  return t ? [t] : [];
}
