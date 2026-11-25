/**
 * "Done" said at the END of what was heard ("two butter chicken half, one naan, done") or on its own: the voice sheet then
 * does exactly what its "Add to order" button does (when nothing is left to choose). Pure, unit-tested in voiceDone.test.ts.
 *
 *   done        "done", "done karo", "ok done", "okay done", "done done"
 *   ho gaya     "ho gaya", "ho gya", "hogaya" (the same words in Devanagari go through the shared toLatin)
 *   bas         "bas", "bas itna", "bas itna hi" (weak: only acted on once the recogniser finalised it)
 *   that's all  "that's all", "that is all"
 *   thanks      "thanks", "thank you" (weak)
 *
 *   add         "add to order", "add to cart", "add it", "add all", "add karo", "add kar do", "order mein daalo", "cart mein daalo", "daal do"
 *               (the spoken "Add to order" button: the same action as done)
 *   slips       the recogniser's slips for an accent: don, doen, doan, doon, dun, dan, dhun, dhan, dawn, "d one"; for "add to order": ad to
 *               order, add the order, add two order, add tu order, at to order, add to border, add to odour
 * Rules: the words count only as the LAST words (a polite "ji" / "bhai" / "please" after them is fine); "well done" (a steak) is
 * never "done"; words that are a dish's own name (menuWords) never count.
 *  - Slips are `weak`: they act only on a FINISHED recogniser result, never on an unfinished (interim) guess.
 *  - A final word within one letter of "done" (or a slip of "order") that is not listed counts only when it is NOT a menu / category
 *    word, not a number, size or Hindi number word, not an ordinary word that matters (dine, dune, gone, bone, none, home, dono, ...),
 *    AND at least one dish is understood before it (`menu.hasDish`); without `hasDish` such guesses are ignored.
 * "Done" is never a command: it does not place an order, send to the kitchen or bill (voiceCommands.ts keeps those, with their
 * confirm tap). This is deliberately NOT in the shared voiceLexicon.json (byte-identical with pos-service, hashed by the parity
 * corpus): the parsers never see these words, because callers parse `rest`, not the transcript.
 */
import type { VoiceMenu } from "./voiceParse";
import { parseOrder } from "./voiceParse";
import { HOMOPHONE, lev, NUM, toLatin, VARIANT_WORD } from "./voiceLexicon";

export interface DoneHit {
  done: boolean;
  /** What was said before the done words (the order itself), punctuation at the end dropped. The whole text when `done` is false. */
  rest: string;
  /** Only an ordinary word ("bas", "thanks") or a slip of the recogniser was heard: an unfinished (interim) guess must not act on it. */
  weak: boolean;
}
/** What the matcher needs from the menu: its words, and whether some dish is understood in a text. */
export interface DoneMenu { menuWords: Set<string>; hasDish?: (text: string) => boolean }

const cache = new WeakMap<VoiceMenu, DoneMenu>();
/** The menu as `splitDone` wants it: dish, option and category words, and "does this text contain a dish" (the on-device parser). */
export function doneMenu(menu: VoiceMenu): DoneMenu {
  let m = cache.get(menu);
  if (!m) {
    const words = new Set(menu.menuWords);
    for (const i of menu.items) for (const w of i.catWords) words.add(w);
    m = { menuWords: words, hasDish: (t) => parseOrder(t, menu, {}).lines.length > 0 };
    cache.set(menu, m);
  }
  return m;
}

interface W { w: string; start: number; end: number }

function words(text: string): W[] {
  const out: W[] = [];
  const re = /[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}.'’-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      w: toLatin(m[0]).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[.-]+$/, ""),
      start: m.index, end: m.index + m[0].length,
    });
  }
  return out;
}

type Pred = (w: W) => boolean;
const eq = (...a: string[]): Pred => (w) => a.includes(w.w);
const or = (...p: Pred[]): Pred => (w) => p.some((f) => f(w));
const GAYA = eq("gaya", "gayaa", "gya", "gyaa", "gaye");
const ITNA = eq("itna", "itnaa", "itana", "itanaa");
const HI = eq("hi", "hee");
const OK = eq("ok", "okay", "oke", "okey", "achha", "accha", "acha", "haan", "han", "theek", "thik");
/** Said after the done words and ignored: "done ji", "bas please". */
const POLITE = eq("ji", "jee", "bhai", "bhaiya", "bhaiyya", "please", "plz", "pls", "sir", "madam", "maam", "boss", "yaar", "na", "hai", "hain");

const DONE = eq("done");
/** How an accent comes out of a speech recogniser. Weak: also ordinary words (a name, a place). */
const DONE_SLIP = eq("don", "doen", "doan", "doon", "dun", "dan", "dhun", "dhan", "dawn", "daan", "doun", "donn", "dohn", "dhone");
const ADD = eq("add", "aid", "ed");
const ADD_SLIP = eq("ad", "at");
const TO = eq("to", "too");
const TO_SLIP = eq("two", "tu", "2");
const THE = eq("the");
const ORDER = eq("order", "ordar", "oder", "ordr");
const ORDER_SLIP = eq("border", "odour", "odor", "older", "orda", "odar", "ordor");
const CART = eq("cart", "kart", "kaart");
const CART_SLIP = eq("card");
const MEIN = eq("mein", "men", "me", "mai", "mei", "main");
const DAALO = eq("daalo", "dalo", "daal", "jodo", "joden", "jodiye");
const DAAL_DO = eq("daaldo", "daldo");
const ADDALL_IT = eq("it", "all");
const DO = eq("do", "dijiye", "karo", "dena", "kijiye");
const KARO = eq("karo", "kardo", "kijiye", "kariye");

/** Ordinary words one letter from "done" / "order" that must stay ordinary text. */
const STOP = new Set(["bone", "cone", "gone", "hone", "lone", "none", "tone", "zone", "dine", "dune", "dome", "dote", "dose", "dole", "dope", "doe", "one", "home", "dene", "deni", "dono", "dona", "donne",
  "line", "fine", "nine", "wine", "odder", "adder", "orders", "ordered", "ode"]);

interface Phrase { seq: Pred[]; weak: boolean; /** only as the WHOLE utterance */ alone?: boolean }

const STATIC: Phrase[] = [
  { seq: [DONE], weak: false },
  { seq: [DONE, eq("karo", "kar", "kardo", "kijiye", "kariye")], weak: false },
  { seq: [DONE, eq("kar"), eq("do", "dijiye")], weak: false },
  { seq: [DONE_SLIP], weak: true },
  { seq: [eq("d"), eq("one")], weak: true },
  { seq: [DONE_SLIP, eq("karo", "kar", "kardo")], weak: true },
  { seq: [eq("ho"), GAYA], weak: false },
  { seq: [eq("ho"), GAYA, eq("hai")], weak: false },
  { seq: [eq("hogaya", "hogya", "hogyaa")], weak: false },
  { seq: [eq("bas"), ITNA], weak: false },
  { seq: [eq("bas"), ITNA, HI], weak: false },
  { seq: [eq("bas"), eq("ho"), GAYA], weak: false },
  { seq: [eq("bas")], weak: true },
  { seq: [eq("thats"), eq("all")], weak: false }, // "that's all" (the apostrophe is dropped)
  { seq: [eq("that"), eq("is"), eq("all")], weak: false },
  { seq: [eq("thanks", "thanx", "thanku", "thainks", "thaanks")], weak: true },
  { seq: [eq("thank", "thaink", "thaank"), eq("you", "u", "yoo", "yu")], weak: true },
  // the spoken "Add to order" button
  ...[ORDER, CART].flatMap((N): Phrase[] => [
    { seq: [ADD, TO, N], weak: false }, { seq: [ADD, TO, THE, N], weak: false }, { seq: [ADD, ADDALL_IT, TO, N], weak: false }, { seq: [ADD, THE, N], weak: false },
    { seq: [N, MEIN, DAALO], weak: false }, { seq: [N, MEIN, DAALO, DO], weak: false }, { seq: [N, MEIN, ADD, KARO], weak: false }, { seq: [N, MEIN, ADD, eq("kar"), eq("do")], weak: false },
  ]),
  { seq: [ADD, ADDALL_IT], weak: false },
  { seq: [ADD, KARO], weak: false, alone: true },        // "ek naan bhi add karo" is a dish said with a verb
  { seq: [ADD, eq("kar"), eq("do")], weak: false, alone: true },
  { seq: [eq("daal"), eq("do", "dijiye")], weak: false },
  { seq: [DAAL_DO], weak: false },
];

/** A last word one letter from "done", not a word that matters (listed in STOP, on the menu, a number, a size). */
function fuzzyDone(w: W, menu?: DoneMenu): boolean {
  const x = w.w;
  if (x.length < 3 || STOP.has(x) || NUM.has(x) || VARIANT_WORD.has(x) || HOMOPHONE.has(x) || menu?.menuWords.has(x)) return false;
  return /^[a-z]+$/.test(x) && lev(x, "done") === 1;
}
/** One letter from "order" (ordar, oder, ordr, border, ...), not a word that matters. */
function fuzzyOrder(w: W, menu?: DoneMenu): boolean {
  const x = w.w;
  return x.length >= 4 && !STOP.has(x) && !menu?.menuWords.has(x) && /^[a-z]+$/.test(x) && lev(x, "order") === 1;
}

interface Hit { from: number; weak: boolean; fuzzy: boolean; alone: boolean; len: number }
/** The done words ending at word index `end` (inclusive). `fuzzy`: a guess, not a listed word. */
function phraseEndingAt(ws: W[], end: number, menu?: DoneMenu): Hit | null {
  let best: Hit | null = null;
  const tryPhrase = (seq: Pred[], weak: boolean, fuzzy: boolean, alone: boolean) => {
    const from = end - seq.length + 1;
    if (from < 0 || !seq.every((p, k) => p(ws[from + k]))) return;
    if (/^(done|d)$/.test(ws[from].w) && from > 0 && ws[from - 1].w === "well") return; // "well done" is a steak, not the end of the order
    if (!best || seq.length > best.len) best = { from, weak, fuzzy, alone, len: seq.length };
  };
  for (const p of STATIC) tryPhrase(p.seq, p.weak, false, !!p.alone);
  // guesses (need a dish understood before them): one letter from "done"; slips of "add to order"
  tryPhrase([(w) => fuzzyDone(w, menu)], true, true, false);
  tryPhrase([or(ADD, ADD_SLIP), or(TO, TO_SLIP, THE), or(ORDER, ORDER_SLIP, CART, CART_SLIP, (w) => fuzzyOrder(w, menu))], true, true, false);
  return best;
}

/** The done words at the end of `text`, and what was said before them. */
export function splitDone(text: string, menu?: DoneMenu): DoneHit {
  const hit = splitEnd(text, menu);
  return { ...hit, rest: scrubDone(hit.rest) };
}

/** A "done" in the MIDDLE ("two naan, done, one roti") is no dish either: it never reaches the parsers ("well done" stays). */
export function scrubDone(text: string): string {
  if (!/done/i.test(text)) return text;
  return text.replace(/(^|[\s,.;:!?])(?<!\bwell\s)done(?=$|[\s,.;:!?])/giu, (_m, pre: string) => pre).replace(/\s+([,.;:!?])/g, "$1").replace(/([,;])(?:\s*[,;])+/g, "$1").replace(/^[\s,.;:!?]+/, "").replace(/\s{2,}/g, " ");
}

function splitEnd(text: string, menu?: DoneMenu): DoneHit {
  const none: DoneHit = { done: false, rest: text, weak: false };
  const ws = words(text);
  if (!ws.length) return none;
  let i = ws.length - 1, found = false, weak = true, fuzzy = false, first = ws.length;
  for (;;) {
    while (i >= 0 && POLITE(ws[i]) && hasPhraseBefore(ws, i, menu)) i--; // "done ji", "bas please"
    if (i < 0) break;
    const hit = phraseEndingAt(ws, i, menu);
    if (!hit) break;
    if (hit.alone && hit.from > 0 && !ws.slice(0, hit.from).every(OK)) break; // "add karo" only as the whole utterance
    found = true; first = hit.from; if (!hit.weak) weak = false; if (hit.fuzzy) fuzzy = true;
    i = hit.from - 1;
    while (i >= 0 && OK(ws[i])) { first = i; i--; } // "ok done", "haan bas"
  }
  if (!found) return none;
  const span = ws.slice(first);
  if (menu && span.every((x) => menu.menuWords.has(x.w) || POLITE(x) || OK(x))) return none;
  // "daal" is also a dish (lentils): "ek daal do" is an order for it
  if (menu && !span.some((x) => ORDER(x) || CART(x)) && span.some((x) => /^(daal|dal)$/.test(x.w) && (menu.menuWords.has(x.w) || menu.menuWords.has("dal") || menu.menuWords.has("daal")))) return none;
  // a slip that is also a word on the menu ("Don Special"): a dish
  if (menu && span.some((x) => (DONE_SLIP(x) || ADD_SLIP(x) || ORDER_SLIP(x) || CART_SLIP(x)) && menu.menuWords.has(x.w))) return none;
  const keep = ws[first - 1];
  const rest = keep ? text.slice(0, keep.end).replace(/[\s,.;:!?]+$/, "") : "";
  if (fuzzy && !menu?.hasDish?.(rest)) return none; // a guess needs a dish understood before it
  return { done: true, rest, weak };
}

/** A polite word counts as part of the ending only when done words precede it ("done ji"), never on its own ("ek naan ji"). */
function hasPhraseBefore(ws: W[], at: number, menu?: DoneMenu): boolean {
  let j = at;
  while (j >= 0 && POLITE(ws[j])) j--;
  return j >= 0 && phraseEndingAt(ws, j, menu) !== null;
}
