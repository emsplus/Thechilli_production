/**
 * "Done" said at the END of a voice order ("two masala chai, one paneer tikka, done"), or on its own: the waiter's voice sheet then
 * adds what is clear to the cart, as "Add to cart" would. Pure; mirrors web-business-admin src/lib/voiceDone.ts.
 * Words: done, done karo, ok / okay done, ho gaya, ho gya, hogaya, bas, bas itna (hi), that's all, that is all, thanks, thank you, and the
 * Devanagari / Gurmukhi forms. "well done" (a steak) is never done. "Done" never places an order, sends a KOT or bills.
 */
const WORD = String.raw`(?:done(?:\s+(?:karo|kar\s*do|kardo))?|ho\s*gaya|ho\s*gya|hogaya|hogya|bas(?:\s+itna(?:\s+hi)?)?|that['’]?s\s+all|that\s+is\s+all|thanks|thank\s+you|हो\s*गया|बस(?:\s+इतना(?:\s+ही)?)?|थैंक्स|थैंक\s+यू|डन|ਹੋ\s*ਗਿਆ|ਬੱਸ|ਡਨ|add\s+(?:to\s+)?(?:the\s+)?(?:order|cart)|add\s+(?:it|all)|(?:order|cart)\s+(?:mein|me|men|mai)\s+(?:daalo|dalo|daal\s*do|add\s+karo)|daal\s*do|ऐड\s+टू\s+(?:ऑर्डर|कार्ट)|(?:ऑर्डर|कार्ट)\s+में\s+(?:डालो|डाल\s*दो|जोड़ो)|डाल\s*दो)`;
const LEAD = String.raw`(?:(?:ok|okay|haan|achha|accha|acha|ओके|ठीक\s+है)[\s,]+)?`;
const TAIL = String.raw`(?:\s+(?:ji|jee|bhai|bhaiya|please|sir|जी|भाई))*`;
const SEP = String.raw`[\s,.;:!?।]`;
const END = new RegExp(String.raw`(?:^|${SEP}+)${LEAD}(?<!\bwell\s)${WORD}${TAIL}${SEP}*$`, "iu");
const MID = new RegExp(String.raw`(^|${SEP})(?<!\bwell\s)done(?=$|${SEP})`, "giu");

export interface DoneHit { done: boolean; rest: string }
/** The menu as the matcher needs it: dish / option words, and whether a text names a dish. Without it only the listed words count. */
export interface DoneMenu { menuWords: Set<string>; hasDish?: (text: string) => boolean }

/** The menu's words (item names), lowercase, and a simple "this text names a dish" (a menu word of 3+ letters is in it). */
export function doneMenuOf(names: string[]): DoneMenu {
  const menuWords = new Set(names.flatMap((n) => n.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)));
  return { menuWords, hasDish: (t) => (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some((w) => w.length >= 3 && menuWords.has(w)) };
}

// How an accent comes out of a speech recogniser: "don", "doen", ... (a menu word is never a slip) and, as guesses that need a dish before
// them, "ad to order", "add two order", "add to border", "add to odour", one letter from "done".
const SLIP = new RegExp(String.raw`(?:^|${SEP}+)${LEAD}(?:don|doen|doan|doon|dun|dan|dhun|dhan|dawn|daan|d\s+one|डन|डोन|डान|डॉन|दन)${TAIL}${SEP}*$`, "iu");
const GUESS = new RegExp(String.raw`(?:^|${SEP}+)${LEAD}(?:ad|at|add)\s+(?:to|the|two|tu|2)\s+(?:order|border|odour|odor|ordar|ordr|older|card|cart)${TAIL}${SEP}*$`, "iu");
const STOP = new Set(["bone", "cone", "gone", "hone", "lone", "none", "tone", "zone", "dine", "dune", "dome", "dote", "dose", "dole", "dope", "doe", "one", "two", "home", "dene", "deni", "dono", "dona", "line", "fine", "nine", "wine"]);
const NUMBERS = new Set(["half", "full", "small", "large", "medium", "ek", "do", "teen", "char", "paanch", "chhe", "saat", "aath", "nau", "das"]);
function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
const lastWord = (t: string) => (t.toLowerCase().match(/[a-z]+$/) ?? [""])[0];

/** The done words at the end of `text` (repeated ones too: "done done"), and the order said before them. */
export function splitDone(text: string, menu?: DoneMenu): DoneHit {
  let rest = text, done = false;
  const cut = (m: RegExpExecArray) => { done = true; rest = rest.slice(0, m.index).replace(new RegExp(String.raw`${SEP}+$`, "u"), ""); };
  for (let i = 0; i < 4; i++) {
    let m = END.exec(rest);
    if (m) { cut(m); continue; }
    const slip = SLIP.exec(rest);
    if (slip && !menu?.menuWords.has(lastWord(slip[0]))) { cut(slip); continue; }
    const head = (r: RegExpExecArray) => rest.slice(0, r.index);
    m = GUESS.exec(rest);
    if (m && menu?.hasDish?.(head(m))) { cut(m); continue; }
    // a last word one letter from "done" that is not a word that matters, with a dish understood before it
    const w = lastWord(rest), at = rest.toLowerCase().lastIndexOf(w);
    if (w.length >= 3 && at >= 0 && /[a-z]$/i.test(rest) && !STOP.has(w) && !NUMBERS.has(w) && !menu?.menuWords.has(w) && lev(w, "done") === 1 && menu?.hasDish?.(rest.slice(0, at))) {
      done = true; rest = rest.slice(0, at).replace(new RegExp(String.raw`${SEP}+$`, "u"), ""); continue;
    }
    break;
  }
  return { done, rest: scrubDone(rest) };
}

/** A "done" in the middle ("two chai, done, one lassi") is no dish: it never reaches the parser. */
export function scrubDone(text: string): string {
  if (!/done/i.test(text)) return text;
  return text.replace(MID, (_m, pre: string) => pre).replace(/\s+([,.;:!?])/g, "$1").replace(/([,;])(?:\s*[,;])+/g, "$1").replace(/^[\s,.;:!?]+/, "").replace(/\s{2,}/g, " ");
}
