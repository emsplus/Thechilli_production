/**
 * "Hey Zonov" wake phrase detection for hands-free ordering (Zonov: the company, zonov.ai). Pure: given the text a speech
 * recogniser produced (interim or final), finds the wake phrase and where it ends, so only the words AFTER it are ever parsed.
 * Unit-tested in wakeWord.test.ts (60+ accepted and 30+ refused spellings, Latin and Devanagari) and e2e/wake-word.spec.ts.
 *
 * "Zonov" is not an English or Hindi word, so recognisers spell it many ways, above all for an Indian accent: hey jonov, hey
 * sonov, a zonov, hey zonoff, hey zonav, he zono, hey jonoff, hey sunao, the same in Devanagari... Matching is PHONETIC, not a list:
 *  1. the text is normalised: Devanagari through the shared transliteration (voiceLexicon toLatin), lower case, accents and
 *     punctuation dropped;
 *  2. each word gets a phonetic key: z / j / s / sh / x (and y at the start) -> Z, every vowel -> A, v / f / w / ph -> V, an "h"
 *     after the first letter is dropped, a final "ao" / "au" / "aw" / "ow" (the "ov" sound heard as a glide, "sunao") -> AV,
 *     repeated symbols collapse (ff, oo, aa): zonov, jonoff, sonov, zanav, sunao -> ZANAV;
 *  3. a word wakes the till when its key is within a small edit distance of ZANAV (sensitivity below), right AFTER a greeting:
 *     hey / hay / hei / he / hi / hai / haay / ok / okay / hello / arey / are / oi / yo, and "a" / "e" / "ae" / "eh" only when they
 *     open what was said (Chrome hears "Hey" as "A"); the Devanagari greetings come out of toLatin as he, hey, hai, e, are;
 *  4. also run together ("heyzonov", "hejonov") and split in two ("zo nov", "zone off", "jo nov", "z nov").
 * Refused on purpose (no wake): the second word alone ("zonov"), everyday words after a greeting ("hey sonu", "hey jaanu",
 * "hey zone", "hey zoom", "hey honey", "hey zero", "hello", "novel"...). Without the "v" sound a word wakes only when it begins
 * with a z / j sound and ends in o / u like "Zonov" without its last letter (zono, zonu, jono): "sonu", "jaanu", "zone" do not.
 *
 * Sensitivity (a per-device setting, Voice settings): strict = an exact phonetic match after a full greeting; normal (default) =
 * one sound off as above; lenient = any one sound off, two when the "v" sound is there, and "a" / "e" anywhere.
 */
import { toLatin } from "./voiceLexicon";

export type WakeSensitivity = "strict" | "normal" | "lenient";
export const WAKE_SENSITIVITIES: { value: WakeSensitivity; label: string }[] = [
  { value: "strict", label: "Strict (fewest false starts)" },
  { value: "normal", label: "Normal" },
  { value: "lenient", label: "Lenient (accents, noisy rooms)" },
];

const GREETING = new Set(["hey", "hay", "hei", "heya", "hi", "hie", "hai", "haay", "haai", "he", "ay", "aye", "ok", "okay", "okey", "oke", "oi", "hello", "hullo",
  "helo", "yo", "arey", "arre", "arrey", "are", "aree"]);
/** Greetings a recogniser makes of "Hey" that are also ordinary words: only when they OPEN what was said. */
const OPENING = new Set(["a", "e", "ae", "eh", "ey", "ei"]);
/** Greetings that strict mode accepts. */
const STRONG = new Set(["hey", "hay", "hei", "hi", "hai", "ok", "okay", "hello"]);
/** Greetings that may be glued in front of the name ("heyzonov"), longest first. */
const GLUED = ["hello", "okay", "arey", "haay", "hey", "hay", "hai", "hei", "ok", "hi", "he"];
const TARGET = "ZANAV";

const norm = (w: string) => toLatin(w).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The phonetic key of one word (see the header): zonov / jonoff / sonov / sunao -> ZANAV. */
export function phoneticKey(word: string): string {
  let w = norm(word);
  if (!w) return "";
  w = w.replace(/ph/g, "f").replace(/sh/g, "s").replace(/zh/g, "z").replace(/(ao|aao|au|aw|ow|aow)$/, "av");
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const k = /[zjsx]/.test(c) || (c === "y" && i === 0) ? "Z"
      : /[aeiouy]/.test(c) ? "A"
        : /[vfw]/.test(c) ? "V"
          : c === "h" && i > 0 ? ""
            : c.toUpperCase();
    if (k && out[out.length - 1] !== k) out += k;
  }
  return out;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** One recogniser word (or two run together) that sounds like "Zonov" at this sensitivity. */
export function soundsLikeZonov(word: string, sensitivity: WakeSensitivity = "normal"): boolean {
  const w = norm(word);
  if (w.length < 3) return false;
  if (learnedHit(w)) return true; // learned on this device (always after a greeting, like every form)
  if (serverForms.has(w)) return true; // testing phase: forms the server sent, through the same guard rails
  const key = phoneticKey(w);
  if (!key.startsWith("Z") && !(sensitivity === "lenient" && key.startsWith("A") && key.length >= 4)) return false;
  const d = lev(key, TARGET);
  if (d === 0) return true;
  if (sensitivity === "strict") return false;
  const hasV = key.includes("V");
  const strongOnset = /^(z|j)/.test(w);
  if (sensitivity === "lenient") return d === 1 || (d === 2 && hasV && w.length >= 4);
  if (d !== 1) return false;
  if (hasV) return key.startsWith("ZAN"); // zanv, zonove, zinoov: z-vowel-n and the v sound ("snow" is no Zonov)
  // no "v" sound: a z / j onset, the first vowel o / u and a final o / u ("zono", "zonu", "jono", "zonoh"); never "zone", "sonu", "jaanu"
  const vowels = w.replace(/[^aeiou]/g, "");
  return strongOnset && key.startsWith("ZAN") && /^[ou]/.test(vowels) && /[ou][hy]?$/.test(w);
}

/** The name said without a greeting: stricter than after "hey" (an everyday word must never wake the till). */
function bareZonov(word: string, sensitivity: WakeSensitivity): boolean {
  const w = norm(word);
  if (w.length < 4 || NEVER.has(w)) return false;
  if (learnedHit(w)) return true;
  const key = phoneticKey(w);
  const d = lev(key, TARGET);
  // an s / sh sound first only with an "o" ("sonov"), never "sunao" / "sunaao" (Hindi "tell me")
  if (/^(s|sh|x)/.test(w) && !/^(s|sh|x)o/.test(w)) return false;
  if (d === 0) return true;
  if (sensitivity === "lenient") return soundsLikeZonov(w, "normal") || weakZonov(w, "lenient"); // bare "jono" / "jon": Lenient only
  return d === 1 && key.includes("V") && key.startsWith("ZAN") && /^(z|j)/.test(w);
}

interface Tok { w: string; start: number; end: number }
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}\p{M}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: norm(m[0]), start: m.index, end: m.index + m[0].length });
  return out;
}

/** End offset of a "Zonov" starting at token j (one word, or two halves "zo nov" / "zone off"), or -1. */
/**
 * What Chrome en-IN really writes for the owner's "Hey Zonov" (live log 2026-11-02): "hey Jon", "hey Jono", "hey jeno",
 * "hey Jonas", "hey jonu": the z heard as j and the final v lost. After a greeting (never "hello"), a word that starts with a
 * j / z sound and whose key starts with ZAN, within two sounds of ZANAV, wakes in Normal; everyday words still never do.
 */
const WEAK_NEVER = new Set(["zone", "zones", "zoom", "zero", "zen", "zinc", "zara", "jaanu", "janu", "jaan", "joan", "johnny", "jonny", "jaane", "jana", "jaana", "jeans", "zinda", "jungle"]);
function weakZonov(word: string, s: WakeSensitivity): boolean {
  if (s === "strict") return false;
  const w = norm(word);
  if (w.length < 3 || w.length > 7 || !/^(z|j)/.test(w) || WEAK_NEVER.has(w) || /^(j|z)aa/.test(w)) return false; // "jaanoo" (jaanu) is a word of love, not the name
  const key = phoneticKey(w);
  return key.startsWith("ZAN") && lev(key, TARGET) <= 2;
}
function zonovAt(toks: Tok[], j: number, s: WakeSensitivity, greeting = ""): number {
  const a = toks[j];
  if (!a) return -1;
  if (soundsLikeZonov(a.w, s)) return a.end;
  if (greeting !== "hello" && greeting !== "hullo" && greeting !== "helo" && weakZonov(a.w, s)) return a.end;
  const b = toks[j + 1];
  if (b && /^(z|j|zed)$/.test(a.w) && phoneticKey(b.w) === "NAV") return b.end; // "z nov": the letter, then the rest
  // split in two: a short z / j / s first half and a second half that starts with n, or "of" / "off" / "ov" after a z / j half
  if (b && a.w.length <= 4 && b.w.length <= 5 && (/^n/.test(b.w) ? /^(z|j|s|sh|y|x)/.test(a.w) : /^(z|j|y)/.test(a.w) && /^(of|off|ov|av|aff)$/.test(b.w))
    && soundsLikeZonov(a.w + b.w, s)) return b.end;
  return -1;
}

/** Character range of the first wake phrase in `text` (end = just after "Zonov"), or null. */
export function findWake(text: string, sensitivity: WakeSensitivity = "normal", opts: { otherGuess?: boolean } = {}): { start: number; end: number } | null {
  const toks = tokens(text);
  // "hey you know": only as the recogniser's 2nd / 3rd guess, never the words it shows (live log 2026-11-02)
  if (opts.otherGuess && sensitivity !== "strict") {
    for (let i = 0; i + 2 < toks.length; i++) if (GREETING.has(toks[i].w) && toks[i + 1].w === "you" && /^(know|now|no|nov)$/.test(toks[i + 2].w)) return { start: toks[i].start, end: toks[i + 2].end };
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const greet = GREETING.has(t.w) && (sensitivity !== "strict" || STRONG.has(t.w));
    const opening = OPENING.has(t.w) && sensitivity !== "strict" && (i === 0 || sensitivity === "lenient");
    if (greet || opening) {
      const end = zonovAt(toks, i + 1, sensitivity, t.w);
      if (end >= 0) return { start: t.start, end };
    }
    // run together: "heyzonov", "okayjonov", "hejonov"; a fast "Hey Zonov" as "hazonov" / "ahzonov" (exact sound only)
    for (const g of GLUED) {
      if (sensitivity === "strict" && !STRONG.has(g)) continue;
      if (t.w.length > g.length + 2 && t.w.startsWith(g) && soundsLikeZonov(t.w.slice(g.length), sensitivity)) return { start: t.start, end: t.end };
    }
    if (sensitivity !== "strict") for (const g of ["ha", "ah", "eh", "ae", "a", "e"]) {
      if (t.w.length > g.length + 3 && t.w.startsWith(g) && phoneticKey(t.w.slice(g.length)) === TARGET && !NEVER.has(t.w.slice(g.length))) return { start: t.start, end: t.end };
    }
    // the name ALONE ("Zonov", said fast or the "hey" lost): normal = as the first word of a phrase, lenient = anywhere (QA B18)
    if (sensitivity !== "strict" && (sensitivity === "lenient" || i === 0 || /[,.;:!?\u0964]\s*$/.test(text.slice(0, t.start))) && bareZonov(t.w, sensitivity)) return { start: t.start, end: t.end };
  }
  return null;
}

/** The text after the wake phrase (leading punctuation and spaces dropped), with its offset in `text`; null when not woken. */
export function afterWake(text: string, sensitivity: WakeSensitivity = "normal", opts: { otherGuess?: boolean } = {}): { rest: string; offset: number } | null {
  const w = findWake(text, sensitivity, opts);
  if (!w) return null;
  let o = w.end;
  while (o < text.length && /[\s,.;:!?\-–—\u0964]/.test(text[o])) o++;
  return { rest: text.slice(o), offset: o };
}

/** The text with every wake phrase taken out ("two naan, hey zonov, one roti" -> "two naan, one roti"): said again mid-order it is no dish. */
export function stripWakes(text: string, sensitivity: WakeSensitivity = "normal"): string {
  let out = text;
  for (let i = 0; i < 5; i++) {
    const w = findWake(out, sensitivity);
    if (!w) break;
    let e = w.end;
    while (e < out.length && /[\s,.;:!?\-–—\u0964]/.test(out[e])) e++;
    out = out.slice(0, w.start) + out.slice(e);
  }
  return out === text ? text : out.replace(/[\s,]+$/, "").replace(/\s{2,}/g, " ");
}

// ---- per-device setting + what the recogniser last returned (Voice settings shows it; memory only, never stored or sent) ----
const SENS_KEY = "pos.wakeSensitivity";
export function wakeSensitivity(): WakeSensitivity {
  try { const v = localStorage.getItem(SENS_KEY); return v === "strict" || v === "lenient" ? v : "normal"; } catch { return "normal"; }
}
export function setWakeSensitivity(v: WakeSensitivity) { try { localStorage.setItem(SENS_KEY, v); } catch { /* private mode: default */ } }
let lastHeard = "";
/** The last words the background recogniser returned while waiting (the end of it, for the debug line in Voice settings). */
export const lastWakeHeard = () => lastHeard;
export const noteWakeHeard = (t: string) => { const s = t.trim(); if (s) lastHeard = s.length > 80 ? `…${s.slice(-80)}` : s; };

// ---- learned pronunciations: extra accepted forms ON TOP of the phonetic matcher, on this device only ----
// Two ways in: Voice settings > Train "Hey Zonov" (manual), and AUTO-LEARN (default on, a visible switch): a near miss heard just
// before a voice command that then succeeded, or right after a Test, is added by itself, at most AUTO_PER_DAY a day. Entries a
// wake has not used for EXPIRE_DAYS are dropped. Text only (never audio), in localStorage (versioned key); NOTHING is sent
// anywhere: no network call, no telemetry. The built-in matcher always stays active, so learning can never remove it.
const LEARN_KEY = "pos.wakeLearned.v2";
const LEARN_KEY_V1 = "pos.wakeLearned.v1";
const AUTO_KEY = "pos.wakeAutoLearn";
export const LEARN_MAX = 20;
export const AUTO_PER_DAY = 3;
export const EXPIRE_DAYS = 30;
const DAY = 86_400_000;
/** Everyday words learning must never turn into the wake word (the refused list of wakeWord.test.ts and friends). */
const NEVER = new Set(["sonu", "sona", "son", "sun", "sunny", "zoom", "zone", "zones", "zero", "honey", "money", "jaanu", "janu", "jaan", "hello", "novel", "nova",
  "soda", "sofa", "snow", "zinc", "zen", "zara", "sanam", "jonas", "johnny", "john", "jon", "mango", "man", "moon", "sir", "sunao", "suno", "sonam",
  "zomato", "joan", "sean", "shaun", "noon", "none", "known", "phone", "jone", "jonny", "sonny", "sonic", "sauna"]);
export interface Learned { w: string; added: number; lastHit: number; auto: boolean }
let learnedCache: Learned[] | null = null;
let now = () => Date.now();
/** Test hook: a fixed clock. */
export const setLearnClock = (f: () => number) => { now = f; };
const ls = () => (typeof localStorage !== "undefined" ? localStorage : null);
function load(): Learned[] {
  if (learnedCache) return learnedCache;
  let list: Learned[] = [];
  try {
    const raw = ls()?.getItem(LEARN_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v?.items)) list = v.items.filter((x: Learned) => typeof x?.w === "string" && typeof x.added === "number").map((x: Learned) => ({ w: x.w, added: x.added, lastHit: typeof x.lastHit === "number" ? x.lastHit : x.added, auto: !!x.auto }));
    else { const old = ls()?.getItem(LEARN_KEY_V1); const o = old ? JSON.parse(old) : null; if (Array.isArray(o?.words)) list = o.words.filter((w: unknown) => typeof w === "string").map((w: string) => ({ w, added: now(), lastHit: now(), auto: false })); }
  } catch { list = []; }
  const t = now();
  learnedCache = list.filter((x) => validLearned(x.w) === null && t - x.lastHit < EXPIRE_DAYS * DAY).slice(-LEARN_MAX);
  return learnedCache;
}
function save(list: Learned[]) {
  learnedCache = list.slice(-LEARN_MAX);
  try { ls()?.setItem(LEARN_KEY, JSON.stringify({ v: 2, items: learnedCache })); } catch { /* private mode: this page only */ }
}
function learnedHit(w: string): boolean {
  const list = load();
  const e = list.find((x) => x.w === w);
  if (!e) return false;
  if (now() - e.lastHit > DAY) { e.lastHit = now(); save(list); } // used: kept for another EXPIRE_DAYS (written at most once a day)
  return true;
}
/** Why a heard word cannot be a learned form of "Zonov" (null = it can). */
export function validLearned(word: string): string | null {
  const w = norm(word);
  if (w.length < 3 || w.length > 14) return "too short or too long";
  if (GREETING.has(w) || OPENING.has(w)) return "a greeting, not the name";
  if (NEVER.has(w)) return "an everyday word";
  const key = phoneticKey(w);
  if (!/^[ZA]/.test(key) || lev(key, TARGET) > 2) return "does not sound like Zonov";
  return null;
}
export const learnedWakes = (): string[] => load().map((x) => x.w);
export const learnedEntries = (): Learned[] => load().map((x) => ({ ...x }));
/** Adds one heard form (manual: Train / settings); the oldest drops out beyond LEARN_MAX. Returns why not, or null when added. */
export function addLearned(word: string, auto = false): string | null {
  const why = validLearned(word);
  if (why) return why;
  const w = norm(word);
  const t = now();
  if (auto && load().filter((x) => x.auto && t - x.added < DAY).length >= AUTO_PER_DAY) return "enough learned today";
  save([...load().filter((x) => x.w !== w), { w, added: t, lastHit: t, auto }]);
  return null;
}
export function removeLearned(word: string) { save(load().filter((x) => x.w !== norm(word))); }
/** Back to the built-in matcher only. */
export function resetLearned() { learnedCache = []; try { ls()?.removeItem(LEARN_KEY); ls()?.removeItem(LEARN_KEY_V1); } catch { /* ignore */ } }
/** Test hook: forget the cache (another tab / a test changed localStorage). */
export const reloadLearned = () => { learnedCache = null; };
export function autoLearnOn(): boolean { try { return ls()?.getItem(AUTO_KEY) !== "0"; } catch { return true; } }
export function setAutoLearn(on: boolean) { try { ls()?.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* private mode */ } }

/**
 * One sample ("Hey Zonov" as the recogniser returned it, Latin or Devanagari): the word(s) used for the name. A greeting first is
 * dropped ("hey jonov" -> "jonov"; "heyjonov" -> "jonov"); "zo nov" is joined. null when no name can be found.
 */
export function nameOfSample(text: string): string | null {
  const t = tokens(text).map((x) => x.w).filter(Boolean);
  if (!t.length) return null;
  let i = 0;
  if (GREETING.has(t[0]) || OPENING.has(t[0])) i = 1;
  else { const g = GLUED.find((x) => t[0].length > x.length + 2 && t[0].startsWith(x)); if (g) return t[0].slice(g.length); }
  const rest = t.slice(i);
  if (!rest.length) return null;
  if (rest.length >= 2 && rest[0].length <= 4 && rest[1].length <= 5) { const joined = rest[0] + rest[1]; if (lev(phoneticKey(joined), TARGET) < lev(phoneticKey(rest[0]), TARGET)) return joined; }
  return rest[0];
}
export interface TrainResult { sample: string; name: string | null; key: string; matchedBefore: boolean; accepted: boolean; why: string | null }
/** Manual training: each sample is checked; the ones that sound like Zonov (and are not already understood) are learned. */
export function train(samples: string[]): TrainResult[] {
  return samples.map((sample) => {
    const name = nameOfSample(sample);
    const matchedBefore = findWake(sample, "normal") !== null;
    if (!name) return { sample, name, key: "", matchedBefore, accepted: false, why: "no name heard" };
    const why = validLearned(name);
    if (!why && !matchedBefore) addLearned(name);
    return { sample, name, key: phoneticKey(name), matchedBefore, accepted: !why, why };
  });
}

/** A greeting followed by a word CLOSE to Zonov that was not accepted ("hey zanob"): the word, else null. */
export function nearMiss(text: string): string | null {
  if (findWake(text, wakeSensitivity()) !== null) return null;
  const t = tokens(text);
  for (let i = 0; i + 1 < t.length; i++) {
    if (!(GREETING.has(t[i].w) || (OPENING.has(t[i].w) && i === 0))) continue;
    const w = t[i + 1].w;
    if (validLearned(w) === null && lev(phoneticKey(w), TARGET) <= 2) return w;
  }
  return null;
}

// Auto-learn: the till remembers the last near miss (text only, in memory) and learns it when a voice command then succeeds
// within AUTO_WINDOW_MS (the speaker meant the wake word and had to try again), or right after a Test.
export const AUTO_WINDOW_MS = 90_000;
let pending: { w: string; at: number } | null = null;
/** A final phrase heard while waiting for the wake word: remembers a near miss. */
export function noteNearMiss(text: string) { const w = nearMiss(text); if (w) pending = { w, at: now() }; }
/** A voice command just succeeded (or a Test ran): learns the remembered near miss when auto-learn is on. Returns the word learned. */
export function confirmNearMiss(): string | null {
  const p = pending;
  pending = null;
  if (!p || !autoLearnOn() || now() - p.at > AUTO_WINDOW_MS) return null;
  return addLearned(p.w, true) === null ? p.w : null;
}
export const forgetNearMiss = () => { pending = null; };

// Testing phase (voiceShare.ts): forms the server sends in GET /voice/wake-config `variants`. Same guard rails as learning
// (validLearned), at most LEARN_MAX, memory only; they never bypass the guard and never replace the built-in matcher.
let serverForms = new Set<string>();
export function setServerForms(list: string[]) { serverForms = new Set(list.map(norm).filter((w) => validLearned(w) === null).slice(0, LEARN_MAX)); }
export const serverWakeForms = () => [...serverForms];

/** The wake decision in words, for the mic debug log: "WAKE matched (...)" or "no wake: <reason>". */
export function explainWake(text: string, sensitivity: WakeSensitivity = "normal"): string {
  const w = findWake(text, sensitivity);
  const toks = tokens(text);
  if (w) {
    const words = toks.filter((t) => t.start >= w.start && t.end <= w.end).map((t) => t.w);
    const name = words.length > 1 ? words.slice(1).join("") : words[0] ?? "";
    const key = phoneticKey(name);
    return `WAKE matched (sensitivity ${sensitivity}, heard “${words.join(" ")}”, key=${key}, distance=${lev(key, TARGET)}${learnedWakes().includes(norm(name)) ? ", learned" : ""})`;
  }
  if (!toks.length) return "no wake: nothing heard";
  const gi = toks.findIndex((t, i) => GREETING.has(t.w) || (OPENING.has(t.w) && (i === 0 || sensitivity === "lenient")));
  if (gi < 0) return "no wake: no greeting (hey / hi / ok / a ...) before a name";
  const next = toks[gi + 1];
  if (!next) return `no wake: “${toks[gi].w}” heard, no name after it yet`;
  const key = phoneticKey(next.w);
  const d = lev(key, TARGET);
  if (NEVER.has(next.w)) return `no wake: “${next.w}” is an everyday word (key=${key})`;
  return `no wake: “${toks[gi].w} ${next.w}” key=${key} distance=${d} (${sensitivity}: needs ${sensitivity === "strict" ? "0" : sensitivity === "normal" ? "0, or 1 with the v sound / a zono-like word" : "≤1, or 2 with the v sound"})`;
}
