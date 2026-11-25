/**
 * Hands-free till commands at the END of what was said ("Hey Zonov, two butter naan, place order"):
 *   place  - "place order", "order place karo", "order laga do", "order kar do", "confirm order" (= the Place order button)
 *   kot    - "send KOT", "send to kitchen", "kitchen me bhejo", "KOT bhejo", "place order and send KOT" (= Place order, then Send KOT)
 *   clear  - "cancel", "clear", "sab hata do" said ON THEIR OWN (empties the draft cart; Undo restores it)
 * Pure: the words and patterns come from the shared lexicon (voiceLexicon.json `commands`, also used by pos-service
 * voice_parse.detect_command). A command is recognised only as the last words (or the whole utterance for "clear"), only
 * from verb + object pairs, and never when the words are a dish's own name, so "kitchen paratha", "one chicken order
 * special" or "send two butter naan" stay dishes. Recogniser slips ("plays order", "send cot", "kitchan") are listed words.
 */
import { CMD_PATTERNS, CMD_WORDS, toLatin } from "./voiceLexicon";

export type VoiceCommand = "place" | "kot" | "clear";
export interface CommandHit { command: VoiceCommand | null; /** What was said before the command (the order itself). */ rest: string }

interface W { w: string; start: number; end: number }

function words(text: string): W[] {
  const out: W[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}.'’-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ w: toLatin(m[0]).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[.-]$/, ""), start: m.index, end: m.index + m[0].length });
  return out;
}

/** Canonical command tokens: [canon | "_" (a skippable little word) | "?" (anything else), first word index, word count]. */
function canonical(ws: W[]): { c: string; i: number; n: number }[] {
  const toks: { c: string; i: number; n: number }[] = [];
  const raw = ws.map((x) => x.w);
  for (let i = 0; i < raw.length;) {
    const hit = CMD_WORDS.find((e) => e.words.every((w, k) => raw[i + k] === w));
    if (hit) { toks.push({ c: hit.canon === "to" ? "_" : hit.canon, i, n: hit.words.length }); i += hit.words.length; continue; }
    toks.push({ c: "?", i, n: 1 });
    i++;
  }
  return toks;
}

/** Longest command pattern ending at canonical token `end` (little words skipped): -> [command, index of its first token]. */
function patternEndingAt(toks: { c: string }[], end: number, wanted?: (cmd: string) => boolean): [string, number] | null {
  let best: [string, number, number] | null = null;
  for (const { cmd, seq } of CMD_PATTERNS) {
    if (cmd === "new_bill" || (wanted && !wanted(cmd))) continue;
    let j = end, k = seq.length - 1;
    while (k >= 0 && j >= 0) {
      if (toks[j].c === "_") { j--; continue; }
      if (toks[j].c !== seq[k]) break;
      k--; j--;
    }
    if (k < 0 && (!best || seq.length > best[2])) best = [cmd, j + 1, seq.length];
  }
  return best ? [best[0], best[1]] : null;
}

/**
 * The command said at the end of `text`, and the text before it. `menuWords` (canonical words of dish names, optional)
 * keeps a dish whose own name is made of command words from ever firing a command.
 */
export function detectCommand(text: string, menu?: { menuWords: Set<string> }): CommandHit {
  const none: CommandHit = { command: null, rest: text };
  const ws = words(text);
  if (!ws.length) return none;
  const toks = canonical(ws);
  let end = toks.length - 1;
  while (end >= 0 && toks[end].c === "_") end--;
  if (end < 0) return none;
  const last = patternEndingAt(toks, end);
  if (!last) return none;
  let [cmd, from] = last;
  if (cmd === "clear") {
    // "cancel" / "clear" / "sab hata do" only as the whole utterance: "samosa cancel kar do" removes the samosa instead
    if (toks.slice(0, from).some((t) => t.c !== "_")) return none;
    return { command: "clear", rest: "" };
  }
  // "place order and send KOT", "order place karo aur kitchen bhejo": a place pattern before the KOT one belongs to it
  let k = from - 1;
  while (k >= 0 && (toks[k].c === "_" || toks[k].c === "link")) k--;
  if (k >= 0) {
    const before = patternEndingAt(toks, k, (c) => c === "place" || c === "kot");
    if (before) { from = before[1]; if (before[0] === "kot") cmd = "kot"; }
  }
  const span = ws.slice(toks[from].i);
  if (menu && span.every((x) => menu.menuWords.has(x.w) || /^(to|the|me|mein|ko|in|please)$/.test(x.w))) return none; // a dish named like a command
  // the order before the command: trailing "and" / "aur" / punctuation dropped
  let restEnd = from;
  while (restEnd > 0 && (toks[restEnd - 1].c === "link" || toks[restEnd - 1].c === "_")) restEnd--;
  const rest = restEnd > 0 ? text.slice(0, ws[toks[restEnd - 1].i + toks[restEnd - 1].n - 1].end) : "";
  return { command: cmd as VoiceCommand, rest: rest.replace(/[\s,.;:!?]+$/, "") };
}
