/**
 * Pure rules of the spoken intents on the voice sheet (VoiceOrder.tsx), unit-tested in voiceFlow.test.ts
 * (docs/VOICE_QA_REPORT.md; owner rules 2026-11):
 * - "done" (its slips and Hinglish forms) and "add to order" / "add to cart" / "add it" ONLY add everything addable to the cart
 *   (Undo in the toast): the cart stays on screen to check; "done" with nothing understood stops listening ("Nothing to add yet");
 * - "place order" (all its forms) and "send to kitchen" (all its forms) = add what is still on the sheet, place the order if it
 *   is not placed yet, and send the kitchen ticket (KOT), by themselves, like the counter's buttons;
 * - a visible countdown first (3 s, 5 s when a dish carries a Check marker; a device setting, 0 = at once); "stop" / "cancel" /
 *   "ruko" / "nahi" / "wait" or a tap cancel it: the dishes stay in the cart, nothing is placed or sent;
 * - an intent is QUEUED and runs once the sheet is ready: never dropped because the server was still reading the order
 *   (stage "busy", `improving`) or an add was still saving, never run twice;
 * - several dishes fit a word ("biryani"): a default is picked (never blocks), marked Check, with Change on the line;
 * - "cancel" (clear) keeps its confirm tap; billing and payment are never run by voice.
 */
import { toLatin } from "@/lib/voiceLexicon";
import type { SheetCommand } from "./voiceSheet";

/** What a spoken ending asks for. `go`: add + place + kitchen ticket; `add`: add to the cart only; `clear`: the clear question. */
export type Intent = { id: number; kind: "add" } | { id: number; kind: "go"; from: "place" | "kot" } | { id: number; kind: "clear" };
let ids = 0;
/** The intent for what was heard: a command wins over the done words said with it ("..., done, place order"). */
export function intentFor(command: SheetCommand | null, done: boolean): Intent | null {
  if (command === "clear") return { id: ++ids, kind: "clear" };
  if (command) return { id: ++ids, kind: "go", from: command };
  return done ? { id: ++ids, kind: "add" } : null;
}

/** What to do with a queued intent now: wait (the sheet is still working), drop (the sheet was closed), or run. */
export function intentStep(s: { stage: string; improving: boolean; saving: boolean; counting: boolean }): "wait" | "drop" | "run" {
  if (s.stage === "closed") return "drop";
  if (s.stage === "busy" || s.stage === "starting" || s.stage === "recording" || s.improving || s.saving || s.counting) return "wait";
  return "run";
}

/** Countdown seconds: the device setting (0 = at once); at least 5 when a dish was added with a doubt (Check), so there is time to change it. */
export const countdownSeconds = (setting: number, checks: number) => (setting <= 0 ? 0 : checks > 0 ? Math.max(5, setting) : setting);

export const commandWords = (c: "place" | "kot") => (c === "kot" ? { doing: "Sending to the kitchen", done: "sent to the kitchen", not: "Not sent to the kitchen" } : { doing: "Placing the order", done: "placed", not: "Not placed" });

/** "Not sent to the kitchen yet: choose the table for “3” first." */
export const holdText = (c: "place" | "kot", say: string) => `${commandWords(c).not} yet: ${say} first.`;

/** The countdown line: "Sending to the kitchen in 3, 2, 1. Say “stop” or tap Cancel." */
export function countdownText(c: "place" | "kot", left: number, total: number, listening: boolean): string {
  const n = Math.max(1, Math.min(total, Math.ceil(left)));
  const steps = Array.from({ length: n }, (_, i) => n - i).join(", ");
  return `${commandWords(c).doing} in ${steps}. ${listening ? "Say “stop” or tap Cancel." : "Tap Cancel to stop it."}`;
}

const STOP = new Set(["stop", "stopp", "cancel", "cancle", "ruko", "ruk", "rukko", "rukiye", "rukjao", "nahi", "nahin", "naheen", "nahiin", "nai", "nahee", "no", "wait", "abort", "mat", "band", "hold", "ruka"]);
/** "stop" / "cancel" / "ruko" / "nahi" (and "wait", "no", "mat karo") in what was said during the countdown. */
export function saysStop(text: string): boolean {
  // Devanagari words go through the shared transliteration (ruko, nahin)
  return text.split(/\s+/).map((w) => toLatin(w)).join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/).some((w) => STOP.has(w));
}

/** Hands-free: just after a voice action, a bare "place order" / "send to kitchen" (the whole utterance) needs no wake phrase this long. */
export const FOLLOW_UP_MS = 15_000;

const norm = (t: string) => toLatin(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/**
 * Several dishes fit what was said ("biryani" -> Chicken / Mutton Biryani): the default, never a block. Rank: (a) the dish the
 * restaurant taught for these words (voice alias), (b) how often it was ordered (when the till knows it), (c) the full name said,
 * then a dish whose name starts with the first word said, (d) menu order. A sold-out dish is never picked when another fits.
 */
export function pickDefault(options: string[], heard: string, menu: { order: (id: string) => number; name: (id: string) => string; soldOut: (id: string) => boolean; alias?: (heard: string) => string | null; popularity?: (id: string) => number }): string {
  const opts = [...new Set(options)];
  if (!opts.length) return "";
  const h = norm(heard).replace(/^(\d+|one|two|three|four|five|ek|do|teen|char|chaar|paanch|a|an)\s+/, "");
  const first = h.split(" ")[0] ?? "";
  const aliased = menu.alias?.(h) ?? null;
  const score = (id: string): number[] => {
    const n = norm(menu.name(id));
    return [menu.soldOut(id) ? 1 : 0, aliased === id ? 0 : 1, -(menu.popularity?.(id) ?? 0), n === h ? 0 : 1, first && n.split(" ")[0] === first ? 0 : 1, menu.order(id)];
  };
  return opts.map((id) => ({ id, s: score(id) })).sort((a, b) => { for (let k = 0; k < a.s.length; k++) if (a.s[k] !== b.s[k]) return a.s[k] - b.s[k]; return 0; })[0].id;
}

/** The Check note on a dish picked for the speaker: shown on the line (with Change) and as the Check marker in the cart. */
export const pickedNote = (count: number) => `picked for you: ${count} dishes fit, change it if needed`;
