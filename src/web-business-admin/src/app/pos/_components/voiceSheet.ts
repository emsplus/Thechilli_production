/**
 * Pure rules of the voice order sheet (VoiceOrder.tsx), unit-tested in voiceSheet.test.ts:
 * - the size a line gets when none was said (the counter's rule, defaultVariantId) and the one-tap switch ("Full +₹180");
 * - the server's `clarifications` as ask lines (never dropped, never guessed);
 * - what blocks "Add to order" (a dish still to choose, a sold-out dish);
 * - spoken commands ("place order", "send to kitchen" run after a countdown, voiceFlow.ts; "cancel" asks first);
 * - how the order was understood ("Understood on device" / "Checked with AI").
 */
import type { MenuItem, VoiceOrder } from "@/lib/types";
import { defaultVariantId, sizeChoices, variantDelta } from "./tickets";

/** The line's current size and the other sizes as one-tap switches ("Full +₹180", back to "Half"). null: no sizes. */
export function sizeSwitch(item: MenuItem, variantId: string | null): { current: string; to: { id: string | null; name: string; label: string }[] } | null {
  if (!item.variants.length) return null;
  const choices = sizeChoices(item);
  const cur = choices.find((c) => c.id === variantId);
  return {
    current: cur?.name ?? "Regular",
    to: choices.filter((c) => c.id !== variantId).slice(0, 3).map((c) => ({ id: c.id, name: c.name, label: [c.name, variantDelta(item, c.id)].filter(Boolean).join(" ") })),
  };
}

/** The size a parsed line goes in with: what was said, else the counter's default (Half). `defaulted` = nobody said it. */
export function lineSize(item: MenuItem, variantId: string | null, defaulted: boolean): { variantId: string | null; defaulted: boolean } {
  if (variantId && item.variants.some((v) => v.id === variantId) && !defaulted) return { variantId, defaulted: false };
  if (!item.variants.length) return { variantId: null, defaulted: false };
  const d = defaultVariantId(item);
  if (d) return { variantId: d, defaulted: true };
  return { variantId: variantId && item.variants.some((v) => v.id === variantId) ? variantId : null, defaulted };
}

export type AskReason = "ambiguous_item" | "fractional_quantity" | "unclear_quantity" | "quantity_without_dish" | string;
export interface Ask { heard: string; qty: number; note: string | null; options: string[]; reason: AskReason }

/**
 * The server's clarifications: two or more dishes = an ask (staff tap one); one dish with an unclear quantity = a line to
 * check; nothing usable = a phrase in "Not matched" (so it is never silently dropped).
 */
export function fromClarifications(r: Pick<VoiceOrder, "clarifications">, has: (id: string) => boolean): { asks: Ask[]; check: Ask[]; unmatched: string[] } {
  const asks: Ask[] = [], check: Ask[] = [], unmatched: string[] = [];
  for (const c of r.clarifications ?? []) {
    const options = [...new Set(c.options.map((o) => o.item_id))].filter(has);
    const a: Ask = { heard: c.heard_text, qty: Math.min(Math.max(c.quantity ?? 1, 1), 99), note: c.note, options, reason: c.reason };
    if (options.length >= 2) asks.push(a);
    else if (options.length === 1) check.push(a);
    else if (c.heard_text.trim()) unmatched.push(c.heard_text);
  }
  return { asks, check, unmatched };
}

/** Why the sheet could not ask for this line: words for the line ("check the quantity", ...). */
export const reasonText = (r: AskReason): string =>
  r === "fractional_quantity" ? "check the quantity (a part plate was heard)"
    : r === "unclear_quantity" ? "check the quantity"
      : r === "quantity_without_dish" ? "a quantity was heard without a dish"
        : "pick the right dish";

/** What still stops "Add to order", in words (the sheet lists them; the button says the first one). */
export function blockers(lines: { ask?: boolean; heard: string; itemId: string; veto?: "veg" }[], nameOf: (id: string) => string, soldOut: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.ask) out.push(`Choose the dish for “${l.heard}”`);
    else if (l.veto === "veg") out.push(vegText(nameOf(l.itemId)));
    else if (soldOut(l.itemId)) out.push(`${nameOf(l.itemId)} is sold out: choose another dish or drop it`);
  }
  return out;
}

export type SheetCommand = "place" | "kot" | "clear";
/** A spoken command as the sheet shows it: what was heard, the confirm button, and whether it sends or cancels. */
export function commandView(c: SheetCommand): { heard: string; button: string; explain: string; tone: "primary" | "danger" } {
  // owner rule 2026-11: a spoken "place order" places AND sends the kitchen ticket (the counter's Place order, then Send to kitchen)
  if (c === "place") return { heard: "place order", button: "Place and send to kitchen", explain: "The order is placed and its kitchen ticket is sent, after a short countdown.", tone: "primary" };
  if (c === "kot") return { heard: "send to kitchen", button: "Add and send to kitchen", explain: "Places the order if it is not placed yet, then sends its kitchen ticket, after a short countdown.", tone: "primary" };
  return { heard: "cancel", button: "Clear the order", explain: "Removes the dishes not sent yet from this order. You can undo it.", tone: "danger" };
}

/** The server command wins only when the device heard none; "clear" never comes with dishes. */
export function pickCommand(device: SheetCommand | null, server: SheetCommand | null | undefined): SheetCommand | null {
  return device ?? (server === "place" || server === "kot" || server === "clear" ? server : null);
}

export type Source = "live" | "typed" | "ai-audio" | "ai-text" | "ai-live";
/** How the order was understood, unobtrusively: on this device, by the server's parser, or checked with the AI model. */
export function understoodBy(source: Source, modelUsed: boolean | undefined, aiImproved = 0): { short: string; ai: boolean } {
  if ((source === "live" || source === "typed") && !aiImproved) return { short: "Understood on device", ai: false };
  if (source === "ai-audio" || modelUsed) return { short: "Checked with AI", ai: true };
  return { short: "Understood by the server", ai: false };
}

// ---- "done": the spoken "Add to order" (src/lib/voiceDone.ts says when it was heard) ----
// Everything that CAN be added is added; what cannot stays on the sheet. A dish with only soft flags ("not sure about this
// dish", "check the quantity") is added and marked "Check" in the cart; a dish still to choose (ask), a sold-out dish and a
// phrase that matched nothing stay on the sheet; a table to choose, a busy table or a bill that cannot take dishes hold the
// whole order (they decide where the dishes go); a spoken command keeps its own confirm tap ("done" never runs one).
/** Veg only is on at the counter and the dish is not veg: never added by voice unless staff tap "Add anyway" (owner, 2026-11-02). */
export const vegText = (name: string) => `${name} is non-veg and Veg only is on: tap “Add anyway” or drop it`;
export interface DoneState {
  lines: { ask?: boolean; heard: string; itemId: string; qty: number; issues: string[]; veto?: "veg" }[];
  /** Phrases that matched no dish and are still waiting for a pick or a drop. */
  unmatched: string[];
  /** The table said (e.g. "3") fits several tables and none is chosen yet. */
  tableAmbiguous: string | null;
  /** The chosen table already has an order and "add to it / separate order" is not chosen yet. */
  busyTable: string | null;
  /** "place order" / "send to kitchen" / "cancel" was heard too: that has its own confirm tap, "done" never runs it. */
  command: SheetCommand | null;
  /** The bill the lines go to can take them. */
  billOk: boolean;
  /** Something besides dishes is on the sheet (customer, order type, table): "done" leaves it open to check instead of closing. */
  hasOther: boolean;
}
/** One thing "done" cannot decide for staff. `blocksAdd`: while "done" is held, "Add to order" stays disabled for it (it can be resolved on the sheet). */
export interface Hold { say: string; reason: string; blocksAdd: boolean; /** it holds the whole order, not just one dish */ whole: boolean }

/** Everything still unresolved, in the order staff should fix it (dishes to choose first). Empty = nothing is left to choose. */
export function doneHolds(d: DoneState, nameOf: (id: string) => string, soldOut: (id: string) => boolean): Hold[] {
  const out: Hold[] = [];
  const add = (say: string, whole = false) => out.push({ say, reason: say.charAt(0).toUpperCase() + say.slice(1), blocksAdd: true, whole });
  for (const l of d.lines) if (l.ask) add(`choose the dish for “${l.heard}”`);
  for (const l of d.lines) if (!l.ask && l.veto === "veg") add(`choose “Add anyway” for ${nameOf(l.itemId)} (non-veg, Veg only is on) or drop it`);
  for (const l of d.lines) if (!l.ask && !l.veto && soldOut(l.itemId)) add(`choose another dish for ${nameOf(l.itemId)}, it is sold out`);
  for (const u of d.unmatched) add(`pick a dish for “${u}” or drop it`);
  if (d.tableAmbiguous) add(`choose the table for “${d.tableAmbiguous}”`, true);
  if (d.busyTable) add(`choose how to add to table ${d.busyTable}`, true);
  if (!d.billOk) add("choose a bill that is not billed", true);
  return out;
}

/** A line with only soft flags: it is added, and marked "Check" in the cart until staff edit or confirm it. */
export const isSoft = (l: { ask?: boolean; issues: string[] }, out: boolean) => !l.ask && !out && l.issues.length > 0;

export type DoneVerdict =
  | { kind: "add"; check: string[] }                                  // nothing left to choose: exactly what "Add to order" does (`check`: dishes added with a soft flag)
  | { kind: "partial"; added: number; check: string[]; holds: Hold[] } // some dishes are clear and added; the unresolved ones stay on the sheet
  | { kind: "hold"; message: string; holds: Hold[] }                  // nothing can be added yet: the sheet says what to fix
  | { kind: "command" }                                               // a place / kitchen / cancel command: its confirm tap decides, "done" adds nothing
  | { kind: "stay" }                                                  // nothing to add but something to look at (a customer, a table): the sheet stays open
  | { kind: "empty" };                                                // nothing understood at all: listening just stops

/** "Almost there: choose the dish for “x” first" (nothing added) / "Added 2 items. Choose the dish for “x” to add the rest." */
export const holdMessage = (holds: Hold[], added = 0): string =>
  added > 0 ? `Added ${added} ${added === 1 ? "item" : "items"}. ${holds[0].reason} to add the rest.` : `Almost there: ${holds[0].say} first`;

/** What "done" does with the sheet as it is now. */
export function doneVerdict(d: DoneState, nameOf: (id: string) => string, soldOut: (id: string) => boolean): DoneVerdict {
  if (d.command) return { kind: "command" };
  const holds = doneHolds(d, nameOf, soldOut);
  const addable = d.lines.filter((l) => !l.ask && !l.veto && !soldOut(l.itemId));
  const added = addable.reduce((n, l) => n + l.qty, 0);
  const check = addable.filter((l) => l.issues.length).map((l) => nameOf(l.itemId));
  if (holds.some((h) => h.whole)) return { kind: "hold", message: holdMessage(holds.filter((h) => h.whole).concat(holds.filter((h) => !h.whole))), holds };
  if (added > 0) return holds.length ? { kind: "partial", added, check, holds } : { kind: "add", check };
  if (holds.length) return { kind: "hold", message: holdMessage(holds), holds };
  return d.hasOther ? { kind: "stay" } : { kind: "empty" };
}

// ---- the same dish said again (owner, 2026-11-02): one line with a higher quantity, never a second line ----
/**
 * Lines for the SAME resolved menu item, size (variant) and note are one line on the sheet: "two butter chicken and one butter
 * chicken" -> Butter Chicken x3, also when the recogniser spelled it differently ("butter chican", Devanagari): the parser
 * resolved them to the same item first. A different size or note stays a separate line; a dish still to choose (ask), words
 * still being heard (pending) and a line staff changed by hand (touched) are never merged. `said`: how many times it was said.
 */
export function mergeSameDishes<L extends { key: string; itemId: string; variantId: string | null; note: string | null; qty: number; ask?: boolean; pending?: boolean; heard: string; issues: string[]; said?: number }>(
  lines: L[], touched: (key: string) => boolean = () => false,
): L[] {
  const out: L[] = [];
  const at = new Map<string, number>();
  for (const l of lines) {
    if (l.ask || l.pending || touched(l.key)) { out.push(l); continue; }
    const k = `${l.itemId}|${l.variantId ?? ""}|${(l.note ?? "").trim().toLowerCase()}`;
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(l); continue; }
    const first = out[i];
    out[i] = { ...first, qty: Math.min(first.qty + l.qty, 99), said: (first.said ?? 1) + 1, heard: `${first.heard} + ${l.heard}`,
      issues: [...new Set([...first.issues, ...l.issues])] };
  }
  return out;
}
