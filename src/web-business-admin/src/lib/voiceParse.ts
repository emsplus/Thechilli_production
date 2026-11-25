/**
 * On-device order parser for live voice ordering: turns a transcript ("do butter naan, ek butter chicken full, customer
 * name Raj, number 98765 43210, takeaway") into menu lines, the customer, the order type and the table.
 * Pure (no React, no network): runs on every speech result in well under a millisecond for a 200-dish menu. Unit-tested by
 * e2e/voice-parse.spec.ts and, with the corpus shared with pos-service voice_parse.py, by src/lib/voiceCorpus.test.ts.
 * Prices are never involved: lines only point at menu items / options.
 *
 * Rules (vocabulary in voiceLexicon.json, shared with the server parser):
 * - Words are folded (Devanagari -> Latin, plural, Hinglish spellings and recogniser slips via synonyms and a sound
 *   skeleton: tika/teeka -> tikka, panir -> paneer, biriyani -> biryani, dosha -> dosa, chaay/tea -> chai).
 * - Every dish is scored by how much of its name was said (60%) and how much of what was said its name, options or
 *   section explain (40%). Several dishes that fit about equally ("naan" with Butter and Garlic Naan) become an ASK line
 *   (`ask`: one-tap pick on the sheet, never added by itself); one clear dish is picked even from part of its name
 *   ("dosa" -> Masala Dosa). A phrase that covers two dishes without a pause ("fish curry rice") is split.
 * - Options: a size word picks the option ("full", "poora", "bada", "large" -> Full; "aadha", "chhota" -> Half); with none
 *   said the dish gets its DEFAULT option (defaultVariantIndex: the cheapest, so Half for Half/Full dishes). "dedh plate"
 *   on a Half/Full dish = 1 Full + 1 Half, "dhai" = 2 Full + 1 Half.
 * - Quantities before or after the dish ("do paneer tikka", "paneer tikka do", "x2"), "ek ek" (one each), corrections
 *   ("nahi nahi teen", "sorry, butter naan"), "cancel that" / "remove last", "samosa hata do", "ek aur", "same again",
 *   and notes ("less spicy", "bina pyaaz" -> "no onion", "zyada teekha" -> "extra spicy").
 *
 * Learning: a phrase staff corrected on the sheet is stored for the restaurant (GET/PUT /menu/voice-aliases) under its
 * normalised key (aliasPhrase). buildVoiceMenu takes those aliases; a learnt phrase goes straight to its dish.
 */
import type { Category, DiningTable, MenuItem, OrderType } from "./types";
import {
  CORRECTIONS, defaultVariantIndex, FILLERS, GIVE_DO, HOMOPHONE, ING, LARGE_SIZES, MILD, NOTE_FIXED, NOTE_LESS, NOTE_MORE, NOTE_NONE,
  NOTE_NONE_AFTER, NUM, ONE_MORE, PHRASE_SYN, phraseAt, rawSim, REGULAR_WORDS, REMOVE_AFTER, REMOVE_BEFORE, REMOVE_LAST, SAME_AGAIN,
  SEPARATORS, SMALL_SIZES, SPICY, SPICY_LESS, SPICY_MORE, SYN, toLatin, VARIANT_WORD,
} from "./voiceLexicon";
import { lexPhrases, lexWord, phoneticSim } from "./dishLexicon";

export { skeleton } from "./voiceLexicon";
export const SURE = 0.75; // below: line flagged "not sure"
export const MIN_MATCH = 0.55; // below: phrase goes to "not matched"
const TIE = 0.04;

export interface ParsedLine {
  /** Stable while the transcript grows: derived from where the phrase starts in the text. */
  key: string;
  itemId: string; variantId: string | null; qty: number; note: string | null;
  heard: string; issues: string[]; confidence: number;
  /** Other dishes that fit about as well (ambiguous / unsure lines): the sheet offers them in a picker. */
  alternatives: string[];
  /** Several dishes fit equally: staff pick one (itemId + alternatives) with one tap; never added before that. */
  ask: boolean;
  /** No option was said: `variantId` is the dish's default (the cheapest). The sheet shows it with one-tap switches. */
  defaulted: boolean;
  /** The normalised phrase (aliasPhrase): what the till learns when staff correct this line. */
  phrase: string;
  /** Matched through a phrase staff taught the till. */
  learnt: boolean;
  /** Still being spoken (from an interim speech result). */
  pending: boolean;
}
export interface ParsedOrder {
  lines: ParsedLine[];
  unmatched: { key: string; text: string; pending: boolean; phrase: string }[];
  name: string | null;
  /** E.164 (+91 for a local number) when the heard number is valid, else null (phoneHeard keeps the raw text). */
  phone: string | null; phoneHeard: string | null;
  type: OrderType | null;
  tableId: string | null; tableLabel: string | null;
  /** Dine-in / outdoor was said but no (known) table: the sheet asks staff to choose one. */
  needsTable: boolean;
  /** The table said fits several tables equally ("3" with AC3 and G3 but no T3): ids to offer as one-tap choices. */
  tableChoices: string[];
  /** "bill number 2", "bill teen", "doosra bill": the till's ticket number (1-99) the order is for, else null. */
  billNo: number | null;
  /** "new bill" / "next bill" / "naya bill": a ticket with the lowest free number (a spoken number wins over it). */
  newBill: boolean;
}

// ---------------------------------------------------------------- words
const EN_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12,
};
/** Recogniser mishearings of a spoken quantity; only trusted at the very start of a phrase and flagged for checking. */
const HOMOPHONE_NUM: Record<string, number> = { ...Object.fromEntries(HOMOPHONE), won: 1 };
const DIGIT_WORD: Record<string, string> = {
  zero: "0", oh: "0", o: "0", nought: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const SPLITTERS = SEPARATORS;
const FILLER = new Set([...FILLERS, "more", "another", "same", "again", "phir", "then", "n", "s", "also", "cheers", "mate", "pe", "par", "se"]);
const SIZE_WORD = new Set([...VARIANT_WORD.keys(), "double", "single", "50ml", "25ml", "35ml", "can"]);
const REGULAR_WORD = new Set([...REGULAR_WORDS, "half", "chhota", "chota", "chhoti", "small"]);

const TYPE_PHRASES: [string[], OrderType][] = [
  [["take", "away"], "takeaway"], [["takeaway"], "takeaway"], [["take", "out"], "takeaway"], [["takeout"], "takeaway"],
  [["to", "go"], "takeaway"], [["collection"], "takeaway"], [["collect"], "takeaway"], [["collecting"], "takeaway"],
  [["pick", "up"], "takeaway"], [["pickup"], "takeaway"], [["parcel"], "takeaway"], [["pack"], "takeaway"], [["packing"], "takeaway"],
  [["home", "delivery"], "delivery"], [["delivery"], "delivery"], [["deliver"], "delivery"],
  [["dine", "in"], "indoor"], [["dining", "in"], "indoor"], [["eat", "in"], "indoor"], [["eating", "in"], "indoor"], [["sit", "in"], "indoor"],
  [["dinein"], "indoor"], [["inside"], "indoor"], [["andar"], "indoor"], [["restaurant", "mein"], "indoor"],
  [["outdoor"], "outdoor"], [["outside"], "outdoor"], [["garden"], "outdoor"], [["terrace"], "outdoor"], [["bahar"], "outdoor"], [["baahar"], "outdoor"], [["patio"], "outdoor"],
];
/** "second bill", "pehla bill": ordinals before "bill". "next/new/naya/agla bill" = a new ticket. */
const ORDINAL: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  pehla: 1, pehli: 1, pahla: 1, pahli: 1, doosra: 2, dusra: 2, doosri: 2, dusri: 2, dooja: 2, teesra: 3, tisra: 3, teesri: 3, tisri: 3,
  chautha: 4, chauthi: 4, paanchva: 5, panchva: 5, paanchvi: 5, chhatha: 6, chhatva: 6,
};
const NEW_BILL_WORD = new Set(["next", "new", "naya", "nayi", "naye", "agla", "agli", "another", "ek", "nai"]);
const BILL_CORRECTION = new Set(["no", "nahi", "nahin", "nai", "sorry", "galti", "actually"]);
const BILL_CUE = new Set(["number", "no", "num", "nambar", "numbar", "nmbr", "nbr", "#"]);
const PHONE_CUE = new Set(["number", "phone", "mobile", "contact", "tel", "telephone", "no", "num", "cell", "ph", "fone", "nambar", "numbar"]);
const NAME_CUE = new Set(["name", "naam", "named", "called"]);
const NAME_SKIP = new Set(["is", "hai", "he", "ka", "ki", "ke", "of", "the", "name", "naam", "customer", "called", "s", "its", "mera", "unka", "inka"]);
const NAME_STOP = new Set(["and", "aur", "number", "phone", "mobile", "contact", "table", "takeaway", "take", "delivery", "collection", "hai",
  "ji", "please", "for", "with", "order", "dine", "eat", "plus", "no", "num", "tel"]);

// ---------------------------------------------------------------- normalising
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function singular(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** A word as both sides of the match see it: lower case, Latin, singular, Hinglish spellings folded (shared synonyms). */
function canon(w: string): string {
  const s = strip(w).replace(/['’]/g, "");
  const direct = SYN.get(s);
  if (direct) return direct;
  const one = singular(s);
  return SYN.get(one) ?? one;
}

/** Multi-word spellings folded to one form ("pani puri" -> "panipuri", "ras malai" -> "rasmalai"), on canonical words. */
function foldPhrases(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    const hit = PHRASE_SYN.find(([from]) => from.every((w, k) => words[i + k] === w));
    if (hit) { out.push(...hit[1]); i += hit[0].length; } else out.push(words[i++]);
  }
  return out;
}

/** 1 = same word, ~0.92 = same sound, 0.68..0.9 = near miss, 0 = different. Short words must match by sound. */
const simMemo = new Map<string, number>();
export function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  let v = simMemo.get(k);
  if (v === undefined) {
    if (simMemo.size > 50_000) simMemo.clear();
    // spelling slips (skeleton, edit distance) or the same sound (dishLexicon.ts foodKey: "mutter" ~ "matar", "chikin" ~ "chicken")
    simMemo.set(k, (v = Math.max(rawSim(a, b), phoneticSim(a, b))));
  }
  return v;
}

// ---------------------------------------------------------------- menu index
interface IdxItem {
  item: MenuItem; cat: string;
  /** name words (weight 1) and words in brackets, "Coke (Bottle)" (weight 0.5) */
  words: { w: string; weight: number }[];
  catWords: string[];
  variants: { id: string; words: string[]; size: string | null; delta: number }[];
  /** Index into `variants` of the option a line gets when none is said, or null (regular). */
  defaultVariant: number | null;
}
/** A learnt phrase as GET /menu/voice-aliases returns it (only these fields are read). */
export interface VoiceAliasIn { phrase: string; menu_item_id: string; variant_id: string | null }
export interface VoiceMenu {
  items: IdxItem[]; vocab: Set<string>; compounds: Map<string, string[]>; menuWords: Set<string>;
  /** aliasPhrase key -> dish (+ option): phrases staff taught the till. */
  aliases: Map<string, { it: IdxItem; variantId: string | null }>;
}

const wordsOf = (s: string) => strip(toLatin(s)).replace(/&/g, " and ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const isNumberish = (w: string) => /^\d+$/.test(w) || w === "pcs" || w === "pc" || w.length < 2;

export function buildVoiceMenu(items: MenuItem[], cats: Category[] = [], aliases: VoiceAliasIn[] = []): VoiceMenu {
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const vocab = new Set<string>(), compounds = new Map<string, string[]>(), menuWords = new Set<string>();
  const out: IdxItem[] = [];
  for (const item of items) {
    if (item.is_active === false) continue;
    const main = item.name.replace(/\([^)]*\)/g, " "), paren = (item.name.match(/\(([^)]*)\)/g) ?? []).join(" ");
    const words: IdxItem["words"] = [];
    for (const w of foldPhrases(lexPhrases(wordsOf(main).filter((x) => x !== "and" && !/^\d+$/.test(x)))).map((x) => canon(lexWord(x, false)))) words.push({ w, weight: 1 });
    for (const w of wordsOf(main)) if (/^\d+$/.test(w)) words.push({ w, weight: 1 }); // "Chicken 65": the number is part of the name
    for (const w of wordsOf(paren)) if (w !== "and" && !isNumberish(w)) words.push({ w: canon(w), weight: 0.5 });
    const active = item.variants.filter((v) => (v as { is_active?: boolean }).is_active !== false);
    const variants = active.map((v) => {
      const vw = wordsOf(v.name).map(canon);
      const size = vw.map((w) => VARIANT_WORD.get(w)).find(Boolean) ?? null;
      return { id: v.id, words: vw, size, delta: Number(v.price_delta ?? 0) };
    });
    // filtered before folding: "Non-Veg" must not become "naan" (SYN non -> naan) and explain a naan said for a chicken dish
    const catWords = wordsOf(catName.get(item.category_id) ?? "").filter((w) => !["and", "non", "veg", "the", "on", "nonveg"].includes(w)).map(canon);
    for (const { w } of words) { vocab.add(w); menuWords.add(w); }
    for (const v of variants) for (const w of v.words) { vocab.add(w); menuWords.add(w); }
    for (let i = 0; i + 1 < words.length; i++) compounds.set(words[i].w + words[i + 1].w, [words[i].w, words[i + 1].w]);
    out.push({ item, cat: catName.get(item.category_id) ?? "", words, catWords, variants, defaultVariant: defaultVariantIndex(variants.map((v) => v.delta)) });
  }
  const menu: VoiceMenu = { items: out, vocab, compounds, menuWords, aliases: new Map() };
  const byId = new Map(out.map((it) => [it.item.id, it]));
  for (const a of aliases) {
    const it = byId.get(a.menu_item_id); // an archived dish: its phrases wait until it is back
    if (!it) continue;
    // re-keyed with today's rules, so a phrase stays found when the normalising above changes
    const key = aliasPhrase(a.phrase, menu) || a.phrase;
    menu.aliases.set(key, { it, variantId: a.variant_id && it.variants.some((v) => v.id === a.variant_id) ? a.variant_id : null });
  }
  return menu;
}

// ---------------------------------------------------------------- tokens
interface Tok { raw: string; w: string; start: number; end: number; punct: boolean; used: boolean }

function tokenize(text: string, menu: VoiceMenu): Tok[] {
  const toks: Tok[] = [];
  const re = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}]+)?|[,.;!?\n\u0964]|&|\+|×/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0], start = m.index, end = start + raw.length;
    if (/^[,.;!?\n\u0964]$/.test(raw)) { toks.push({ raw, w: ",", start, end, punct: true, used: false }); continue; }
    if (raw === "&") { toks.push({ raw, w: "and", start, end, punct: false, used: false }); continue; }
    if (raw === "×") { toks.push({ raw, w: "x", start, end, punct: false, used: false }); continue; }
    if (raw === "+") { toks.push({ raw, w: "+", start, end, punct: false, used: false }); continue; }
    const low = strip(toLatin(raw)).replace(/['’]/g, "");
    let mm: RegExpExecArray | null;
    if ((mm = /^x(\d{1,2})$/.exec(low)) || (mm = /^(\d{1,2})x$/.exec(low))) { // "x2", "2x"
      toks.push({ raw, w: "x", start, end, punct: false, used: false }, { raw, w: mm[1], start, end, punct: false, used: false });
      continue;
    }
    toks.push({ raw, w: low, start, end, punct: false, used: false });
  }
  // "7 up" -> "7up", "50 ml" -> "50ml", "seven up" -> "7up" when the menu has that word; "sixty five" -> "65" for "Chicken 65"
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (a.punct || b.punct) continue;
    const n = /^\d+$/.test(a.w) ? a.w : EN_NUM[a.w] !== undefined ? String(EN_NUM[a.w]) : null;
    const joined = n !== null ? n + b.w : null;
    if (joined && menu.vocab.has(joined)) {
      toks.splice(i, 2, { raw: `${a.raw} ${b.raw}`, w: joined, start: a.start, end: b.end, punct: false, used: false });
      continue;
    }
    const tens = EN_NUM[a.w], ones = EN_NUM[b.w];
    if (tens >= 20 && tens % 10 === 0 && ones !== undefined && ones < 10 && menu.vocab.has(String(tens + ones)) && i > 0 && !toks[i - 1].punct && menu.menuWords.has(canon(toks[i - 1].w))) {
      toks.splice(i, 2, { raw: `${a.raw} ${b.raw}`, w: String(tens + ones), start: a.start, end: b.end, punct: false, used: false });
    }
  }
  return toks;
}

function numberAt(toks: Tok[], i: number): { value: number; len: number; homophone: boolean } | null {
  const t = toks[i];
  if (!t || t.punct || t.used) return null;
  if (/^\d{1,3}$/.test(t.w)) { const v = Number(t.w); return v > 0 ? { value: v, len: 1, homophone: false } : null; }
  const en = EN_NUM[t.w];
  if (en !== undefined) {
    const next = toks[i + 1];
    if (en >= 20 && en % 10 === 0 && next && !next.punct && EN_NUM[next.w] !== undefined && EN_NUM[next.w] < 10) return { value: en + EN_NUM[next.w], len: 2, homophone: false };
    return { value: en, len: 1, homophone: false };
  }
  const hi = NUM.get(t.w);
  if (hi !== undefined && hi !== 0.5) return { value: hi, len: 1, homophone: false }; // a half ("aadha", "half") is a size, not a count
  const ho = HOMOPHONE_NUM[t.w];
  if (ho !== undefined) return { value: ho, len: 1, homophone: true };
  return null;
}

const titleCase = (s: string) => s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

// ---------------------------------------------------------------- phone (mirrors the API's normalize_phone)
/** Same rules as apps/api app/schemas/crm.py normalize_phone: E.164 with India's +91 for a local number, or null when invalid. */
export function normalizePhone(v: string): string | null {
  const raw = v.trim().replace(/\(0\)/g, "");
  let d = raw.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  else if (d.startsWith("0")) d = "+91" + d.slice(1);
  else if (!d.startsWith("+") && /^[6-9]\d{9}$/.test(d)) d = "+91" + d; // an Indian mobile said without 0 / +91
  else if (!d.startsWith("+")) d = "+" + d;
  return /^\+\d{8,15}$/.test(d) ? d : null;
}

function phoneRun(toks: Tok[], from: number): { digits: string; end: number } | null {
  let digits = "", i = from, mult = 1;
  const count = () => digits.replace(/\D/g, "").length;
  // a complete number ends the run, so "98765 43210 two naan" does not swallow the "two" (India mobiles have 10 digits, 11 with a leading 0)
  const full = () => count() >= (digits.startsWith("+") || digits.startsWith("00") ? 12 : digits.startsWith("0") ? 11 : 10);
  for (; i < toks.length && !full(); i++) {
    const t = toks[i];
    if (t.punct) { if (t.raw === "\n" || count() >= 10) break; continue; }
    if (t.w === "+" || t.w === "plus") { if (digits) break; digits += "+"; continue; }
    if (/^\d+$/.test(t.w)) { digits += t.w.length === 1 ? t.w.repeat(mult) : t.w; mult = 1; continue; }
    if (t.w === "double") { mult = 2; continue; }
    if (t.w === "triple") { mult = 3; continue; }
    const d = DIGIT_WORD[t.w];
    if (d !== undefined) { digits += d.repeat(mult); mult = 1; continue; }
    break;
  }
  const n = digits.replace(/\D/g, "").length;
  return n >= 7 ? { digits, end: i } : null;
}

// ---------------------------------------------------------------- tables
/** A table label as compared: lower case, letters and digits only ("Table 3" -> "table3", "AC-3" -> "ac3"). */
export const compactLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The tables a spoken label can mean (same rules as the server's resolve_table should follow, see docs/VOICE_SHEET_STATUS.md):
 * 1. an exact label ("T3", "AC 3", "3", "Table 3");
 * 2. a bare number ("table 3", "3") -> the plain table series: labels "T3", "Tbl 3", "Table 3", "03";
 * 3. else every table whose label is letters + that number (AC3, G3): one = that table, several = staff choose.
 * Order in the list never decides (that sent "table 3" to AC3 because AC3 was created first, audit V-03).
 */
export function tableCandidates(label: string, tables: DiningTable[]): DiningTable[] {
  let key = compactLabel(label);
  if (/^table\d/.test(key)) key = key.slice(5);
  const active = tables.filter((t) => t.is_active !== false);
  const exact = active.filter((t) => { const l = compactLabel(t.label); return l === key || l === `table${key}`; });
  if (exact.length) return exact;
  if (!/^\d+$/.test(key)) return [];
  const n = String(Number(key));
  const plain = active.filter((t) => new RegExp(`^(?:t|tbl|table)?0*${n}$`).test(compactLabel(t.label)));
  if (plain.length) return plain;
  return active.filter((t) => new RegExp(`^[a-z]+0*${n}$`).test(compactLabel(t.label)));
}

// ---------------------------------------------------------------- the parser
export function parseOrder(text: string, menu: VoiceMenu, opts: { tables?: DiningTable[]; pendingFrom?: number } = {}): ParsedOrder {
  const tables = opts.tables ?? [], pendingFrom = opts.pendingFrom ?? Infinity;
  const toks = tokenize(text, menu);
  const out: ParsedOrder = { lines: [], unmatched: [], name: null, phone: null, phoneHeard: null, type: null, tableId: null, tableLabel: null, needsTable: false, tableChoices: [], billNo: null, newBill: false };
  const consume = (a: number, b: number) => { for (let k = a; k < b; k++) toks[k].used = true; };
  const slice = (a: number, b: number) => text.slice(toks[a].start, toks[b - 1].end);

  // ---- bill (ticket) number: "bill number 2", "bill no do", "bill 3", "second bill", "pehla bill", "new bill" ----
  if (!menu.menuWords.has("bill")) {
    // "no bill number 2" / "sorry, bill 3": the correction word is about the bill, never about the dish said before it
    const dropCorrection = (a: number) => { for (let k = a - 1; k >= 0 && !toks[k].used && (toks[k].punct || BILL_CORRECTION.has(toks[k].w)); k--) if (!toks[k].punct) toks[k].used = true; };
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].used || !/^(bill|bil|beel)$/.test(toks[i].w)) continue;
      const prev = toks[i - 1];
      if (prev && !prev.punct && !prev.used && prev.w in ORDINAL) { out.billNo = ORDINAL[prev.w]; out.newBill = false; consume(i - 1, i + 1); dropCorrection(i - 1); continue; }
      if (prev && !prev.punct && !prev.used && NEW_BILL_WORD.has(prev.w) && prev.w !== "ek") { out.billNo = null; out.newBill = true; consume(i - 1, i + 1); dropCorrection(i - 1); continue; }
      let j = i + 1, cue = false;
      while (j < toks.length && !toks[j].used && BILL_CUE.has(toks[j].w)) { cue = true; j++; if (toks[j]?.punct && toks[j].raw === ".") j++; }
      const n = toks[j] && !toks[j].punct && !toks[j].used ? numberAt(toks, j) : null;
      if (n && (!n.homophone || cue) && n.value >= 1 && n.value <= 99) { out.billNo = n.value; out.newBill = false; consume(i, j + n.len); dropCorrection(i); }
      else consume(i, i + 1); // a bare "bill" says nothing; a phone number after "bill number" keeps its cue word
    }
  }

  // ---- order type words first (they tell which area a bare table number means): "dine in", "outdoor", "andar", "takeaway"...
  const typeHits: { i: number; len: number; type: OrderType }[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (const [words, type] of TYPE_PHRASES) {
      if (words.every((w, k) => toks[i + k] && !toks[i + k].used && toks[i + k].w === w) && !(words.length === 1 && menu.menuWords.has(words[0]))) {
        typeHits.push({ i, len: words.length, type }); i += words.length - 1; break;
      }
    }
  }
  const areaHint = [...typeHits].reverse().find((h) => h.type === "indoor" || h.type === "outdoor")?.type ?? null;

  /** A table label at j: "5", "five", "t3", "t 3", "O2" (letter + digits), optionally after "number"/"no". */
  const readLabel = (j: number, needDigitsOnlyCue: boolean): { label: string; len: number } | null => {
    let k = j;
    while (k < toks.length && (toks[k].punct || /^(number|no|num|is|hai)$/.test(toks[k].w))) k++;
    const t = toks[k];
    if (!t || t.used || t.punct) return null;
    if (/^[a-z]\d{1,3}$/.test(t.w)) return { label: t.w, len: k - j + 1 };
    if (/^[a-z]$/.test(t.w) && toks[k + 1] && !toks[k + 1].punct && /^\d{1,3}$/.test(toks[k + 1].w)) return { label: t.w + toks[k + 1].w, len: k - j + 2 };
    // "table AC3", "table ac 3": a longer letter prefix only when this restaurant has that exact label
    const two = /^[a-z]{2,3}$/.test(t.w) && toks[k + 1] && !toks[k + 1].punct && /^\d{1,3}$/.test(toks[k + 1].w) ? t.w + toks[k + 1].w : null;
    if (/^[a-z]{2,3}\d{1,3}$/.test(t.w) && tables.some((tb) => compactLabel(tb.label) === t.w)) return { label: t.w, len: k - j + 1 };
    if (two && tables.some((tb) => compactLabel(tb.label) === two)) return { label: two, len: k - j + 2 };
    if (needDigitsOnlyCue) return null;
    const n = numberAt(toks, k);
    if (n && !n.homophone) return { label: String(n.value), len: k - j + n.len };
    return null;
  };
  const findTable = (label: string): { hit: DiningTable | undefined; choices: DiningTable[] } => {
    let pool = tableCandidates(label, tables);
    // "outdoor table 3" / "bahar table 2": a bare number means a table of the area said (O3), not the plain T3
    const num = /^\d+$/.test(compactLabel(label)) ? Number(compactLabel(label)) : null;
    if (areaHint && num !== null && !pool.some((tb) => tb.area === areaHint)) {
      const inHint = tables.filter((tb) => tb.is_active !== false && tb.area === areaHint && new RegExp(`^[a-z]*0*${num}$`).test(compactLabel(tb.label)));
      if (inHint.length) pool = inHint;
    }
    if (pool.length <= 1) return { hit: pool[0], choices: [] };
    // several fit ("3" with AC3 and G3 but no T3): the area said decides, else staff choose (never the first in the list)
    const inArea = areaHint ? pool.filter((tb) => tb.area === areaHint) : [];
    if (inArea.length === 1) return { hit: inArea[0], choices: [] };
    return { hit: undefined, choices: inArea.length ? inArea : pool };
  };

  // table: "table 5", "table number 12", "table t3", "dine in table T3", "outdoor O2", "bahar table 4"
  let tableHeard: string | null = null;
  const takeTable = (label: string, a: number, b: number) => {
    consume(a, b);
    const { hit, choices } = findTable(label);
    tableHeard = label;
    out.tableId = hit?.id ?? null;
    out.tableChoices = choices.map((t) => t.id);
    out.tableLabel = hit?.label ?? (/^[a-z]+\d/i.test(label) ? label.toUpperCase() : `Table ${label}`);
    const areas = new Set(choices.map((t) => t.area));
    tableArea = hit?.area ?? (areas.size === 1 ? [...areas][0] : /^o\d/i.test(label) ? "outdoor" : areaHint ?? "indoor");
  };
  let tableArea: OrderType | null = null;
  for (let i = 0; i < toks.length && !tableHeard; i++) {
    if (toks[i].used || !/^(table|tbl|mez|mej|tebal|tabel)$/.test(toks[i].w)) continue;
    const r = readLabel(i + 1, false);
    if (r) takeTable(r.label, i, i + 1 + r.len);
  }
  // no "table" word: a letter+number label right after a dine-in / outdoor word ("outdoor o2", "andar t3"); a bare number
  // there only when a quantity or a pause follows and it names a table of that area ("garden 1 ek chicken 65" -> G1, but
  // "outdoor 2 lassi" stays two lassi)
  for (const h of typeHits) {
    if (tableHeard || (h.type !== "indoor" && h.type !== "outdoor")) continue;
    const r = readLabel(h.i + h.len, true);
    if (r) { takeTable(r.label, h.i + h.len, h.i + h.len + r.len); continue; }
    const at = h.i + h.len, n = numberAt(toks, at);
    if (!n || n.homophone) continue;
    const after = toks[at + n.len];
    if (after && !after.punct && !numberAt(toks, at + n.len)) continue;
    const fit = tables.filter((t) => t.is_active !== false && t.area === h.type && new RegExp(`^[a-z]*0*${n.value}$`).test(compactLabel(t.label)));
    if (fit.length === 1) takeTable(fit[0].label, at, at + n.len);
  }
  // a table's own label said on its own ("T3 ek masala chai", "AC 2 teen jeera rice"): only an exact label of this
  // restaurant, never a word of a dish name
  for (let i = 0; i < toks.length && !tableHeard; i++) {
    const t = toks[i];
    if (t.used || t.punct) continue;
    let label: string | null = null, len = 1;
    if (/^[a-z]{1,3}\d{1,3}$/.test(t.w)) label = t.w;
    else if (/^[a-z]{1,3}$/.test(t.w) && !NUM.has(t.w) && EN_NUM[t.w] === undefined && toks[i + 1] && !toks[i + 1].punct && !toks[i + 1].used && /^\d{1,3}$/.test(toks[i + 1].w)) { label = t.w + toks[i + 1].w; len = 2; }
    if (!label || menu.menuWords.has(canon(t.w)) || menu.vocab.has(label)) continue;
    if (tables.some((tb) => compactLabel(tb.label) === label)) takeTable(label, i, i + len);
  }

  // phone: after a cue word ("number 07700 900123", "phone oh seven seven ..."), or any long run of digits
  for (let i = 0; i < toks.length && !out.phoneHeard; i++) {
    const t = toks[i];
    if (t.used || t.punct) continue;
    let from = -1;
    if (PHONE_CUE.has(t.w)) { let j = i + 1; while (j < toks.length && (toks[j].punct || /^(is|hai|he|ka|h)$/.test(toks[j].w))) j++; from = j; }
    else if (/^\+?\d+$/.test(t.w) || t.w === "+") from = i;
    if (from < 0) continue;
    const run = phoneRun(toks, from);
    if (!run) continue;
    const n = run.digits.replace(/\D/g, "").length;
    if (from === i && n < 10 && !/^(\+|0)/.test(run.digits)) continue; // no cue: only clear phone numbers
    out.phoneHeard = slice(from, run.end).replace(/^[\s,.]+|[\s,.]+$/g, "");
    out.phone = normalizePhone(run.digits);
    consume(PHONE_CUE.has(t.w) ? i : from, run.end);
  }

  // customer name: "customer name Raj", "naam Raj hai", "customer ka naam Raj Kumar", "customer Raj"
  for (let i = 0; i < toks.length && !out.name; i++) {
    const t = toks[i];
    if (t.used || !(NAME_CUE.has(t.w) || t.w === "customer")) continue;
    let j = i + 1;
    while (j < toks.length && !toks[j].used && (NAME_SKIP.has(toks[j].w) || toks[j].punct && j === i + 1)) j++;
    const start = j;
    while (j < toks.length && j - start < 3) {
      const n = toks[j];
      const num = numberAt(toks, j);
      if (n.used || n.punct || NAME_STOP.has(n.w) || /\d/.test(n.w) || (num && !num.homophone) || PHONE_CUE.has(n.w)
        || (FILLER.has(n.w) && !NAME_CUE.has(t.w)) || menu.menuWords.has(canon(n.w))) break;
      j++;
    }
    if (j > start) {
      out.name = titleCase(slice(start, j));
      let e = j;
      while (e < toks.length && !toks[e].used && /^(hai|ji|he)$/.test(toks[e].w)) e++;
      consume(i, e);
    } else if (t.w === "customer") toks[i].used = true;
  }

  // order type: last one said wins (the words are consumed so they never read as dishes)
  for (const h of typeHits) { out.type = h.type; if (!toks.slice(h.i, h.i + h.len).some((t) => t.used)) consume(h.i, h.i + h.len); }
  // a table decides dine-in vs outdoor by its area; a table word with takeaway / delivery is ignored
  if (tableHeard) {
    if (out.type === "takeaway" || out.type === "delivery") { out.tableId = null; out.tableLabel = null; }
    else out.type = tableArea ?? out.type ?? "indoor";
  }
  out.needsTable = (out.type === "indoor" || out.type === "outdoor") && !out.tableId;



  // ---- dish phrases: the rest of the words become units (dish words, quantities, notes, corrections), then operations
  const units = buildUnits(toks, menu);
  const segs = runUnits(units);
  const lines: (ParsedLine & { _qtyExplicit: boolean })[] = [];
  const lineFor = (s: Seg): (ParsedLine & { _qtyExplicit: boolean })[] | null => {
    const made = makeLines(s, menu, text, pendingFrom);
    if (!made.lines.length) { if (made.unmatched) out.unmatched.push(made.unmatched); return null; }
    return made.lines;
  };
  /** The last line for an item the words name (corrections and removals), searched from the end. */
  const find = (words: Tok[]) => {
    const ws = dishWords(words, menu);
    if (!ws.length) return -1;
    const m = matchDish(mergeCompounds(ws, menu), menu);
    const al = findAlias(dishWords(words, menu, false), menu) ?? findAlias(ws, menu);
    const ids = new Set([al?.it.item.id, m?.best.it.item.id, ...(m?.ties.map((t) => t.it.item.id) ?? [])].filter(Boolean));
    for (let k = lines.length - 1; k >= 0; k--) if (ids.has(lines[k].itemId)) return k;
    return -1;
  };
  for (const op of segs) {
    const last = lines[lines.length - 1];
    if (op.k === "add") {
      const ws = dishWords(op.seg.toks, menu);
      if (last && ws.length && ws.every((w) => VARIANT_WORD.has(w))) { // "mutton biryani ek, full": the option of the dish before
        const it = menu.items.find((x) => x.item.id === last.itemId);
        if (it?.variants.length) { const v = pickVariant(it, null, ws.map((w) => VARIANT_WORD.get(w)!)); last.variantId = v.id; last.defaulted = false; continue; }
      }
      const ls = lineFor(op.seg); if (ls) lines.push(...ls); continue;
    }
    if (op.k === "setqty") { if (last) { last.qty = clampQty(op.qty); last._qtyExplicit = true; } continue; }
    if (op.k === "inc") { if (last) last.qty = clampQty(last.qty + op.by); continue; }
    if (op.k === "same") { if (last) last.qty = clampQty(last.qty * 2); continue; }
    if (op.k === "note") { if (last) last.note = [last.note, op.text].filter(Boolean).join(", "); continue; }
    if (op.k === "removeLast") { lines.pop(); continue; }
    if (op.k === "remove") { const k = find(op.words); if (k >= 0) lines.splice(k, 1); continue; }
    if (op.k === "fix") {
      const sizes = op.seg.toks.filter((t) => VARIANT_WORD.has(canon(t.w)));
      if (last && sizes.length && sizes.length === dishWords(op.seg.toks, menu).length) { // "nahi, full": the option of the last line
        const it = menu.items.find((x) => x.item.id === last.itemId);
        if (it) { const v = pickVariant(it, null, sizes.map((t) => VARIANT_WORD.get(canon(t.w))!)); last.variantId = v.id; last.defaulted = false; last.issues = last.issues.filter((i) => !i.startsWith("option")); }
        if (op.seg.qty !== null) last.qty = clampQty(op.seg.qty);
        continue;
      }
      const k = find(op.seg.toks);
      if (k >= 0) { if (op.seg.qty !== null) { lines[k].qty = clampQty(op.seg.qty); lines[k]._qtyExplicit = true; } continue; }
      const seg = op.seg.qty === null && last?._qtyExplicit ? { ...op.seg, qty: last.qty } : op.seg;
      const ls = lineFor({ ...seg, mods: [...(last?.note ? [last.note] : []), ...seg.mods] });
      if (ls) { if (last) lines.pop(); lines.push(...ls); }
    }
  }
  out.lines = lines.map(({ _qtyExplicit: _q, ...l }) => l);
  return out;
}

const clampQty = (q: number) => Math.min(Math.max(Math.round(q), 1), 99);

// ---------------------------------------------------------------- units
type Unit =
  | { k: "w"; t: Tok; tail?: Tok[] }
  | { k: "n"; v: number; toks: Tok[]; homophone: boolean }
  | { k: "sep" } | { k: "x"; t: Tok }
  | { k: "corr" } | { k: "rmAfter" } | { k: "rmBefore" } | { k: "rmLast" } | { k: "more"; toks: Tok[] } | { k: "same" }
  | { k: "each"; v: number }
  | { k: "note"; text: string };

/** A note starting at words[i] ("less spicy", "bina pyaaz", "lehsun nahi", "extra chutney"): [canonical text, words used]. */
function noteAt(ws: string[], i: number, menu: VoiceMenu): [string, number] | null {
  const f = NOTE_FIXED.find(([p]) => p.every((w, k) => ws[i + k] === w));
  if (f) return [f[1], f[0].length];
  const w = ws[i], nx = ws[i + 1];
  if (w === undefined) return null;
  if (SPICY_MORE.has(w) && nx !== undefined && SPICY.has(nx)) return ["extra spicy", 2];
  if (SPICY_LESS.has(w) && nx !== undefined && SPICY.has(nx)) return ["less spicy", 2];
  if (MILD.has(w) && !menu.menuWords.has(w)) return ["less spicy", 1];
  for (const [list, word] of [[NOTE_MORE, "extra"], [NOTE_LESS, "less"], [NOTE_NONE, "no"]] as const) {
    const n = phraseAt(ws, i, list);
    if (!n) continue;
    const ing = ws[i + n];
    if (ing === undefined) return null;
    if (ING.has(ing)) return [`${word} ${ING.get(ing)}`, n + 1];
    if (SPICY.has(ing)) return [word === "no" ? "not spicy" : `${word} spicy`, n + 1];
    // "extra chutney", "bina sambar": any other plain word is kept as said; "no" + something else is a correction ("no no three")
    if (word !== "no" || w !== "no") if (!NUM.has(ing) && !EN_NUM[ing] && !/^\d+$/.test(ing) && !SEPARATORS.has(ing) && !FILLER.has(ing)) return [`${word} ${ing}`, n + 1];
    return null;
  }
  if (ING.has(w) && nx !== undefined) {
    const n = phraseAt(ws, i + 1, NOTE_NONE_AFTER);
    if (n) return [`no ${ING.get(w)}`, n + 1];
    const l = phraseAt(ws, i + 1, NOTE_LESS);
    if (l && !ws[i + 1 + l]) return [`less ${ING.get(w)}`, l + 1];
  }
  if (SPICY.has(w) && !menu.menuWords.has(w)) return ["spicy", 1];
  return null;
}

/** Tokens (table, phone, name, bill and type words already used) -> units. Phrases never cross punctuation or used words. */
function buildUnits(toks: Tok[], menu: VoiceMenu): Unit[] {
  const units: Unit[] = [];
  const sep = () => { if (units.length && units[units.length - 1].k !== "sep") units.push({ k: "sep" }); };
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (t.used || t.punct) { sep(); i++; continue; }
    // the words from here to the next pause, for multi-word phrases
    const run: Tok[] = [];
    for (let j = i; j < toks.length && !toks[j].used && !toks[j].punct && run.length < 6; j++) run.push(toks[j]);
    const ws = run.map((x) => x.w);
    let k: number;
    if ((k = phraseAt(ws, 0, REMOVE_LAST))) { units.push({ k: "rmLast" }); i += k; continue; }
    if ((k = phraseAt(ws, 0, SAME_AGAIN))) { units.push({ k: "same" }); i += k; continue; }
    if ((k = phraseAt(ws, 0, REMOVE_AFTER))) { units.push({ k: "rmAfter" }); i += k; continue; }
    if ((k = phraseAt(ws, 0, GIVE_DO))) { i += k; continue; } // "de do", "kar do": a verb, never the number two
    if ((k = phraseAt(ws, 0, ONE_MORE))) { units.push({ k: "more", toks: run.slice(0, k) }); i += k; continue; }
    const note = noteAt(ws, 0, menu);
    if (note) { units.push({ k: "note", text: note[0] }); i += note[1]; continue; }
    if (REMOVE_BEFORE.has(t.w) && !menu.menuWords.has(t.w)) { units.push({ k: "rmBefore" }); i++; continue; }
    if ((t.w === "x" || t.w === "times") && units.length && units[units.length - 1].k === "w" && numberAt(toks, i + 1)) { units.push({ k: "x", t }); i++; continue; }
    const num = numberAt(toks, i);
    const prevW = units[units.length - 1];
    if (num && /^\d+$/.test(t.w) && prevW?.k === "w" && menu.items.some((it) => it.words.some((x) => x.w === t.w) && it.words.some((x) => x.w === canon(prevW.t.w) || x.w === canon(lexWord(prevW.t.w))))) {
      units.push({ k: "w", t }); i++; continue; // "chicken 65": the number is part of the name
    }
    if (num) {
      let v = num.value, len = num.len;
      const nx = toks[i + len];
      if (nx && !nx.punct && !nx.used && (nx.w === "dozen" || nx.w === "darjan") && v < 12) { v *= 12; len++; }
      const again = numberAt(toks, i + len);
      if (again && again.value === v && !num.homophone && !/^\d/.test(t.w) && v < 12) { units.push({ k: "each", v }); i += len + again.len; continue; } // "ek ek", "do do": each
      units.push({ k: "n", v, toks: toks.slice(i, i + len), homophone: num.homophone });
      i += len;
      continue;
    }
    if ((k = phraseAt(ws, 0, CORRECTIONS))) { units.push({ k: "corr" }); i += k; continue; }
    if (SPLITTERS.has(t.w) && !andPair(toks, i, menu)) { sep(); i++; continue; }
    if (FILLER.has(t.w) && !menu.menuWords.has(canon(t.w))) { const p = units[units.length - 1]; if (p?.k === "w") (p.tail ??= []).push(t); i++; continue; } // kept for the heard text only
    units.push({ k: "w", t });
    i++;
  }
  return units;
}

/** "apple and mango", "passion & vanilla": a dish name with "and" in it. */
function andPair(toks: Tok[], i: number, menu: VoiceMenu): boolean {
  const a = toks[i - 1], b = toks[i + 1];
  return !!a && !!b && menu.items.some((it) => /(&|\band\b)/i.test(it.item.name) && it.words.some((x) => x.w === canon(a.w)) && it.words.some((x) => x.w === canon(b.w)));
}

interface Seg { toks: Tok[]; qtyToks: Tok[]; qty: number | null; mods: string[]; homophone: boolean; tail?: Tok[] }
type Op =
  | { k: "add"; seg: Seg } | { k: "fix"; seg: Seg } | { k: "setqty"; qty: number } | { k: "inc"; by: number } | { k: "same" }
  | { k: "note"; text: string } | { k: "remove"; words: Tok[] } | { k: "removeLast" };

/** Units -> operations on the order (same state machine as pos-service voice_parse.parse). */
function runUnits(units: Unit[]): Op[] {
  const ops: Op[] = [];
  // a chunk (between pauses / "aur") that starts with a dish and ends with a number puts every number AFTER its dish:
  // "chai do samosa teen" = 2 chai, 3 samosa
  const postfix = new Array<boolean>(units.length).fill(false);
  for (let a = 0; a < units.length;) {
    let b = a;
    while (b < units.length && !["sep", "corr", "rmAfter", "rmBefore", "rmLast", "more", "same"].includes(units[b].k)) b++;
    const body = units.slice(a, b).filter((u) => u.k !== "note");
    const pf = body.length > 1 && body[0].k === "w" && body[body.length - 1].k === "n";
    for (let i = a; i < b; i++) postfix[i] = pf;
    a = b + 1;
  }
  const wordAhead = (i: number, skipNum = false) => {
    for (let j = i + 1; j < units.length; j++) {
      const k = units[j].k;
      if (k === "w") return true;
      if (k === "note" || (skipNum && k === "n")) continue;
      return false;
    }
    return false;
  };
  let cur: Seg | null = null, pendingQty: number | null = null, pendingTok: Tok[] = [], pendingHomo = false, pendingMods: string[] = [];
  let mode: "corr" | "rm" | null = null, corrSeg: Seg | null = null, eachQty: number | null = null;
  const flush = () => { if (cur && cur.toks.length) ops.push({ k: "add", seg: cur }); cur = null; };
  const endCorr = () => {
    if (corrSeg && corrSeg.toks.length) ops.push(mode === "rm" ? { k: "remove", words: corrSeg.toks } : { k: "fix", seg: corrSeg });
    else if (corrSeg && corrSeg.qty !== null && mode === "corr") ops.push({ k: "setqty", qty: corrSeg.qty });
    corrSeg = null; mode = null;
  };
  const fresh = (): Seg => {
    const s: Seg = { toks: [], qtyToks: pendingTok, qty: pendingQty ?? eachQty, mods: pendingMods, homophone: pendingHomo };
    pendingQty = null; pendingTok = []; pendingMods = []; pendingHomo = false;
    return s;
  };
  units.forEach((u, i) => {
    switch (u.k) {
      case "w":
        if (mode) { (corrSeg ??= fresh()).toks.push(u.t); return; }
        (cur ??= fresh()).toks.push(u.t);
        if (u.tail) (cur.tail ??= []).push(...u.tail);
        return;
      case "x": return; // "garlic naan x2": the number that follows is this dish's quantity
      case "n": {
        const prevX = units[i - 1]?.k === "x";
        if (mode === "rm" && corrSeg?.toks.length) endCorr();
        if (mode === "corr") {
          if (corrSeg?.toks.length) endCorr();
          if (wordAhead(i)) { corrSeg = { toks: [], qtyToks: u.toks, qty: u.v, mods: [], homophone: false }; mode = "corr"; }
          else { flush(); ops.push({ k: "setqty", qty: u.v }); mode = null; corrSeg = null; }
          return;
        }
        const curSeg = cur as Seg | null;
        if (u.homophone && (curSeg?.toks.length || pendingQty !== null || !wordAhead(i))) return; // "to", "for" as plain words
        if (curSeg && curSeg.toks.length) {
          if (curSeg.qty === null || prevX || curSeg.qty === eachQty) {
            if (prevX || postfix[i] || !wordAhead(i)) { curSeg.qty = u.v; curSeg.qtyToks = [...curSeg.qtyToks, ...u.toks]; flush(); return; }
          }
          flush();
        }
        if (pendingQty !== null && pendingQty !== u.v && !pendingHomo) { /* "do teen chai": the later number wins */ }
        pendingQty = u.v; pendingTok = u.toks; pendingHomo = u.homophone;
        if (eachQty !== null) eachQty = null;
        return;
      }
      case "each": flush(); eachQty = u.v; return;
      case "sep": if (mode && (corrSeg?.toks.length || corrSeg?.qty != null)) endCorr(); flush(); return; // "sorry, butter naan": the correction goes on after the pause
      case "corr": if (mode) endCorr(); flush(); mode = "corr"; corrSeg = null; return;
      case "rmBefore":
        if (mode) endCorr();
        if ((cur as Seg | null)?.toks.length && !wordAhead(i)) { ops.push({ k: "remove", words: (cur as unknown as Seg).toks }); cur = null; return; } // "chilli paneer cancel"
        flush();
        if (wordAhead(i)) { mode = "rm"; corrSeg = null; } else ops.push({ k: "removeLast" });
        return;
      case "rmAfter":
        if ((cur as Seg | null)?.toks.length) { ops.push({ k: "remove", words: (cur as unknown as Seg).toks }); cur = null; return; }
        if (mode && corrSeg?.toks.length) { mode = "rm"; endCorr(); return; }
        if (mode) endCorr();
        ops.push({ k: "removeLast" });
        return;
      case "rmLast": if (mode) endCorr(); flush(); ops.push({ k: "removeLast" }); return;
      case "more": {
        if (mode) endCorr();
        const c = cur as Seg | null;
        if (c?.toks.length && c.qty === null) { c.qty = 1; flush(); return; } // "dal makhani ek, aur ..."
        flush();
        if (wordAhead(i)) { pendingQty = 1; pendingTok = u.toks; } else ops.push({ k: "inc", by: 1 });
        return;
      }
      case "same": if (mode) endCorr(); flush(); ops.push({ k: "same" }); return;
      case "note": {
        const c = (mode ? corrSeg : cur) as Seg | null;
        if (c?.toks.length) c.mods.push(u.text);
        else if (wordAhead(i, true)) pendingMods.push(u.text);
        else ops.push({ k: "note", text: u.text });
        return;
      }
    }
  });
  if (mode) endCorr();
  flush();
  return ops;
}

// ---------------------------------------------------------------- lines
/**
 * The dish words of a phrase: fillers set aside, words canonical, multi-word spellings folded. `lex` (matching): other names
 * of a dish first ("golgappe" -> "pani puri"), and each word that is not the menu's own word becomes its lexicon word
 * ("meethee" -> sweet, "chawal" -> rice, "badaa" -> large; dishLexicon.ts). Without `lex` (the key a lesson is stored under):
 * the words as said, so a lesson stays as narrow as the phrase staff corrected ("murgi" is not every "chicken").
 */
function dishWords(body: Tok[], menu: VoiceMenu, lex = true): string[] {
  const words: string[] = [];
  const said = body.filter((t) => !(FILLER.has(t.w) && !menu.menuWords.has(canon(t.w)))).map((t) => t.w);
  for (const raw of foldPhrases(lex ? lexPhrases(said) : said)) {
    const c0 = canon(raw);
    const w = !lex || menu.menuWords.has(c0) || SYN.has(c0) || VARIANT_WORD.has(c0) ? c0 : canon(lexWord(raw));
    if (w.includes(" ")) words.push(...w.split(" ")); else words.push(w);
  }
  return words;
}

/**
 * The option for a dish: the one whose name was said, else a size word mapped onto the dish's options (half/small -> the
 * cheapest, full/large -> the dearest when the names differ), else the default (cheapest). `id` null = regular.
 */
function pickVariant(it: IdxItem, matched: string | null, sizes: string[]): { id: string | null; defaulted: boolean; unknown: string[] } {
  if (matched) return { id: matched, defaulted: false, unknown: [] };
  const dflt = it.defaultVariant !== null ? it.variants[it.defaultVariant].id : null;
  const unknown: string[] = [];
  let id: string | null | undefined;
  for (const s of sizes) {
    const exact = it.variants.find((v) => v.size === s);
    if (exact) { id = exact.id; continue; }
    if (!it.variants.length) { if (!REGULAR_WORD.has(s) || s === "half") unknown.push(s); continue; } // half a dish with no Half option: flagged
    if (SMALL_SIZES.has(s) || REGULAR_WORDS.has(s)) { id = dflt; continue; }
    if (LARGE_SIZES.has(s)) { // the option named full / large, else the last option that is not the default (menus list sizes small to big)
      const big = it.variants.find((v) => v.size && LARGE_SIZES.has(v.size)) ?? [...it.variants].reverse().find((v) => v.id !== dflt);
      if (big) { id = big.id; continue; }
    }
    unknown.push(s);
  }
  if (id !== undefined) return { id, defaulted: false, unknown };
  return { id: dflt, defaulted: dflt !== null, unknown };
}

/** "aur ek pizza" -> "ek pizza" in unmatched text: the joiner is not part of the phrase (same words as voice_parse.py). */
const LEADING_JOINERS = /^(?:(?:aur|and|bhi|plus|also|phir|then|or)[\s,]+)+/i;

function makeLines(s: Seg, menu: VoiceMenu, text: string, pendingFrom: number): { lines: (ParsedLine & { _qtyExplicit: boolean })[]; unmatched?: ParsedOrder["unmatched"][number] } {
  const first = s.qtyToks[0] && s.qtyToks[0].start < s.toks[0].start ? s.qtyToks[0] : s.toks[0];
  const lastTok = [...s.toks, ...s.qtyToks, ...(s.tail ?? [])].reduce((a, b) => (b.end > a.end ? b : a));
  const heard = text.slice(first.start, lastTok.end);
  const pending = first.start >= pendingFrom || lastTok.end > pendingFrom;
  const words = dishWords(s.toks, menu);
  const plainWords = dishWords(s.toks, menu, false);
  const phrase = plainWords.join(" ");
  const note = s.mods.length ? [...new Set(s.mods)].join(", ") : null;
  const qty = s.qty ?? 1;
  if (!words.length) return { lines: [] };
  const merged = mergeCompounds(words, menu);
  const near = findAlias(plainWords, menu) ?? findAlias(words, menu);
  let m = matchDish(merged, menu);
  const learnt = near && (!near.fuzzy || !(m && m.conf >= SURE && !m.ties.length)) ? near : null;
  // a phrase naming two dishes without a pause ("fish curry rice", "butter chicken garlic naan"): split where both halves are clear
  let parts: { m: DishMatch; toks: Tok[]; words: number }[] | null = null;
  if (!learnt && merged.length >= 2 && (!m || m.ties.length || m.best.qCov < 0.999)) parts = splitPhrase(merged, menu, m);
  const out: (ParsedLine & { _qtyExplicit: boolean })[] = [];
  if (!learnt && !m && !parts) return { lines: [], unmatched: { key: `U${first.start}`, text: heard.replace(LEADING_JOINERS, ""), pending, phrase } };
  const issues: string[] = [];
  if (s.homophone && s.qty !== null) issues.push(`check the quantity (heard “${s.qtyToks[0]?.raw}”)`);
  if (qty > 20) issues.push(`check the quantity (${qty})`);
  const push = (it: IdxItem, variant: { id: string | null; defaulted: boolean; unknown: string[] }, q: number, extra: Partial<ParsedLine>, keySuffix = "") => {
    out.push({ key: `L${first.start}${keySuffix}`, itemId: it.item.id, variantId: variant.id, qty: clampQty(q), note, heard, phrase, pending,
      issues: [...issues, ...variant.unknown.map((u) => `option “${u}” not on the menu: regular chosen`), ...(extra.issues ?? [])],
      confidence: extra.confidence ?? 1, alternatives: extra.alternatives ?? [], ask: extra.ask ?? false, learnt: extra.learnt ?? false,
      defaulted: variant.defaulted, _qtyExplicit: s.qty !== null });
  };
  if (learnt) {
    const alternatives = m ? [m.best.it.item.id, ...m.alternatives].filter((id) => id !== learnt.it.item.id).slice(0, 5) : [];
    const v = learnt.variantId ? { id: learnt.variantId, defaulted: false, unknown: [] } : pickVariant(learnt.it, null, learnt.sizes);
    push(learnt.it, { ...v, unknown: learnt.unknownSizes }, qty, { confidence: 1, alternatives, learnt: true });
    return { lines: out };
  }
  if (parts) {
    parts.forEach((p, k) => {
      const v = pickVariant(p.m.best.it, p.m.best.variantId, p.m.best.sizes);
      // a dish found from ONE word inside a longer phrase ("lime soda sweet") is a guess: shown as "not sure"
      const conf = p.m.best.it.words.length > 1 && p.words === 1 ? Math.min(p.m.conf, 0.7) : p.m.conf;
      push(p.m.best.it, v, k === 0 ? qty : 1, { confidence: Math.round(conf * 100) / 100, alternatives: p.m.alternatives,
        issues: conf < SURE ? ["not sure about this dish"] : [] }, k ? `s${k}` : "");
    });
    return { lines: out };
  }
  m = m!;
  if (m.ties.length && [m.best, ...m.ties].some((c) => c.variantId || c.sizes.length)) {
    // an option word with a dish word that fits several dishes ("full tandoori"): only one of them has that option
    const all = [m.best, ...m.ties];
    const fit = all.filter((c) => c.it.variants.length && (c.variantId || !pickVariant(c.it, null, c.sizes).unknown.length));
    if (fit.length === 1) m = { ...m, best: fit[0], ties: [], conf: Math.max(m.conf, SURE), alternatives: all.filter((c) => c !== fit[0]).map((c) => c.it.item.id) };
  }
  const best = m.best;
  if (m.ties.length) {
    push(best.it, { id: null, defaulted: false, unknown: [] }, qty, { ask: true, confidence: Math.round(m.conf * 100) / 100, alternatives: m.alternatives,
      issues: [`${m.ties.length + 1} dishes fit: pick the right one`] });
    return { lines: out };
  }
  const flags = m.conf < SURE ? ["not sure about this dish"] : [];
  const conf = Math.round(m.conf * 100) / 100;
  // "dedh plate" on a Half/Full dish = one Full + one Half; "dhai" = two Full + one Half
  if (qty % 1 !== 0) {
    const half = best.it.variants.find((v) => v.size === "half"), full = best.it.variants.find((v) => v.size === "full");
    if (half && full) {
      push(best.it, { id: full.id, defaulted: false, unknown: [] }, Math.floor(qty), { confidence: conf, alternatives: m.alternatives, issues: flags });
      push(best.it, { id: half.id, defaulted: false, unknown: [] }, 1, { confidence: conf, alternatives: m.alternatives, issues: flags }, "h");
      return { lines: out };
    }
    push(best.it, pickVariant(best.it, best.variantId, best.sizes), Math.ceil(qty), { confidence: conf, alternatives: m.alternatives,
      issues: [...flags, `check the quantity (${qty} said)`] });
    return { lines: out };
  }
  const v = pickVariant(best.it, best.variantId, best.sizes);
  // an unknown word next to a dish with options may have been the option ("poori plate"): the default is not sure then
  if (v.defaulted && best.qCov < 0.999) {
    push(best.it, v, qty, { confidence: Math.min(conf, 0.7), alternatives: m.alternatives, issues: [...flags, "check the option"] });
    return { lines: out };
  }
  push(best.it, v, qty, { confidence: conf, alternatives: m.alternatives, issues: flags });
  return { lines: out };
}

/** Best split of a phrase into consecutive dishes that are each clear on their own, or null. */
function splitPhrase(words: string[], menu: VoiceMenu, whole: DishMatch | null): { m: DishMatch; toks: Tok[]; words: number }[] | null {
  let best: { parts: DishMatch[]; min: number } | null = null;
  const go = (from: number, acc: DishMatch[]) => {
    if (from === words.length) {
      if (acc.length < 2) return;
      const min = Math.min(...acc.map((p) => p.best.score));
      if (!best || min > best.min) best = { parts: [...acc], min };
      return;
    }
    if (acc.length >= 3) return;
    for (let to = from + 1; to <= Math.min(words.length, from + 4); to++) { // a dish name is at most four words here
      if (to - from === words.length) continue;
      const m = matchDish(words.slice(from, to), menu);
      if (!m || m.ties.length || m.best.qCov < 0.999 || m.best.score < 0.7 || m.margin < 0.15) continue; // each part must be clearly one dish
      go(to, [...acc, m]);
    }
  };
  go(0, []);
  const b = best as { parts: DishMatch[]; min: number } | null;
  if (!b || (whole && !whole.ties.length && b.min <= whole.best.score)) return null;
  return b.parts.map((m) => ({ m, toks: [], words: m.words }));
}

/**
 * The key a heard phrase is learnt under: "two chicken tikki no onion" -> "chicken tikki", "do lamb kadai" -> "lamb kadai".
 * Quantities, fillers and cooking notes go; words are folded like the matcher folds them. Equals ParsedLine.phrase for a
 * phrase the parser cut out of a longer transcript. "" = nothing dish-like.
 */
export function aliasPhrase(text: string, menu: VoiceMenu): string {
  const units = buildUnits(tokenize(text, menu), menu);
  return dishWords(units.flatMap((u) => (u.k === "w" ? [u.t] : [])), menu, false).join(" ");
}

/** How close a heard phrase must sound to a learnt one, and how clearly it must beat the next learnt phrase. */
const ALIAS_NEAR = 0.7, ALIAS_GAP = 0.05;

/** The learnt phrase that SOUNDS like `words` ("chikan tikky" ~ "chicken tikki"): word by word, or run together. */
function nearAlias(words: string[], menu: VoiceMenu): { it: IdxItem; variantId: string | null } | undefined {
  let best: { a: { it: IdxItem; variantId: string | null }; score: number } | null = null, second = 0;
  const joined = words.join("");
  for (const [key, a] of menu.aliases) {
    const kw = key.split(" ");
    let score = wordSim(joined, kw.join(""));
    if (kw.length === words.length) {
      const per = kw.map((w, i) => wordSim(words[i], w));
      if (per.every((x) => x > 0)) score = Math.max(score, per.reduce((x, y) => x + y, 0) / per.length);
    }
    if (best && score <= best.score) { second = Math.max(second, score); continue; }
    if (best) second = Math.max(second, best.score);
    best = { a, score };
  }
  return best && best.score >= ALIAS_NEAR && best.score - second >= ALIAS_GAP ? best.a : undefined;
}

/**
 * A learnt phrase: the exact key, else the key without size words ("large chicken tikki"), the spoken size picking the option,
 * else one that sounds close enough (`fuzzy`: the caller lets a clear menu match win over it).
 */
function findAlias(words: string[], menu: VoiceMenu): { it: IdxItem; variantId: string | null; unknownSizes: string[]; sizes: string[]; fuzzy: boolean } | null {
  if (!menu.aliases.size || !words.length) return null;
  const exact = menu.aliases.get(words.join(" "));
  if (exact) return { ...exact, unknownSizes: [], sizes: [], fuzzy: false };
  const plain = words.filter((w) => !SIZE_WORD.has(w));
  let fuzzy = false;
  let a = plain.length && plain.length < words.length ? menu.aliases.get(plain.join(" ")) : undefined;
  if (!a && plain.length) { a = nearAlias(plain, menu); fuzzy = !!a; }
  if (!a) return null;
  let variantId = a.variantId;
  const unknownSizes: string[] = [], sizes: string[] = [];
  for (const w of words) {
    if (!SIZE_WORD.has(w)) continue;
    const v = a.it.variants.find((x) => x.words.some((vw) => wordSim(w, vw) >= 0.9));
    if (v) variantId = v.id;
    else if (VARIANT_WORD.has(w) && a.it.variants.length) sizes.push(VARIANT_WORD.get(w)!);
    else if (REGULAR_WORD.has(w)) variantId = null;
    else unknownSizes.push(w);
  }
  return { it: a.it, variantId, unknownSizes, sizes, fuzzy };
}

function mergeCompounds(words: string[], menu: VoiceMenu): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? words[i] + words[i + 1] : null;
    if (pair && menu.vocab.has(pair) && !menu.vocab.has(words[i])) { out.push(pair); i++; continue; } // "ras malai" said, "Rasmalai" on the menu
    const split = menu.compounds.get(words[i]);
    if (split && !menu.vocab.has(words[i])) { out.push(...split); continue; } // "rasmalai" said, "Ras Malai" on the menu
    out.push(words[i]);
  }
  return out;
}

interface Scored { it: IdxItem; score: number; itemCov: number; qCov: number; variantId: string | null; count: number; sizes: string[] }
interface DishMatch { best: Scored; ties: Scored[]; alternatives: string[]; conf: number; /** best score minus the next dish's */ margin: number; words: number }

/** Same scoring as pos-service voice_parse.score_item: 60% how much of the name was said, 40% how much of what was said it explains. */
/** Said words that name no dish on their own ("veg", "fresh", "special"): never a reason to rule a dish out. */
const QUALIFIER = new Set(["veg", "fresh", "special", "plain", "hot", "cold"]);

function scoreItem(words: string[], it: IdxItem, menu?: VoiceMenu): Scored | null {
  const usedP = new Array<boolean>(words.length).fill(false);
  const sims = new Array<number>(words.length).fill(0);
  let got = 0, total = 0, count = 0;
  for (const { w, weight } of it.words) {
    total += weight;
    let best = -1, bs = 0;
    for (let k = 0; k < words.length; k++) {
      if (usedP[k]) continue;
      const s = wordSim(words[k], w);
      if (s > bs) { bs = s; best = k; }
    }
    if (best >= 0) { usedP[best] = true; sims[best] = bs; got += weight * bs; count++; }
  }
  if (!got) return null;
  let variantId: string | null = null, covered = 0, denom = 0;
  const sizes: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (usedP[k]) { covered += sims[k]; denom++; continue; }
    const v = it.variants.find((x) => x.words.some((vw) => wordSim(w, vw) >= 0.9));
    if (v) { variantId = v.id; covered++; denom++; continue; }
    if (SIZE_WORD.has(w)) { const c = VARIANT_WORD.get(w); if (c) sizes.push(c); else if (!REGULAR_WORD.has(w)) sizes.push(w); continue; }
    if (it.catWords.some((c) => wordSim(w, c) >= 0.9)) { covered++; denom++; continue; }
    // the whole name counts: a word of ANOTHER dish's name that this dish does not have rules it out ("butter naan" is never
    // Butter Chicken, "chicken naan" is no dish of this menu)
    if (menu && menu.menuWords.has(w) && !QUALIFIER.has(w) && !it.words.some((x) => wordSim(w, x.w) >= 0.9)) return null;
    denom++;
  }
  const itemCov = got / total, qCov = denom ? covered / denom : 1;
  return { it, score: 0.6 * itemCov + 0.4 * qCov, itemCov, qCov, variantId, count, sizes };
}

/** Results per menu and phrase: the live transcript is re-parsed on every word, so the same phrases come back again and again. */
const matchMemo = new WeakMap<VoiceMenu, Map<string, DishMatch | null>>();
function matchDish(words: string[], menu: VoiceMenu): DishMatch | null {
  if (!words.length) return null;
  let memo = matchMemo.get(menu);
  if (!memo) matchMemo.set(menu, (memo = new Map()));
  const key = words.join(" ");
  if (memo.has(key)) return memo.get(key)!;
  if (memo.size > 5000) memo.clear();
  const m = matchDishUncached(words, menu);
  memo.set(key, m);
  return m;
}

function matchDishUncached(words: string[], menu: VoiceMenu): DishMatch | null {
  const scored: Scored[] = [];
  for (const it of menu.items) {
    const s = scoreItem(words, it, menu);
    if (s && s.score >= MIN_MATCH && s.qCov >= 0.5) scored.push(s);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.count - a.count || a.it.item.name.length - b.it.item.name.length);
  const best = scored[0];
  const ties = scored.slice(1).filter((s) => best.score - s.score < TIE && s.count === best.count);
  const runnerUp = scored[1]?.score ?? 0;
  let conf = best.score;
  // the only dish that fits everything said is sure even from part of its name ("dosa" -> Masala Dosa)
  if (!ties.length && best.qCov >= 0.999 && best.score - runnerUp >= 0.1) conf = Math.max(conf, 0.75 + 0.25 * best.itemCov);
  if (ties.length) conf = Math.min(conf, 0.6);
  const alternatives = ties.length || conf < SURE || best.score - runnerUp < 0.1
    ? scored.slice(1).filter((s) => s.score >= Math.max(MIN_MATCH, best.score - 0.15)).slice(0, 5).map((s) => s.it.item.id) : [];
  return { best, ties, alternatives, conf, margin: best.score - runnerUp, words: words.length };
}
