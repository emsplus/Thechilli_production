/**
 * Direct mode (owner, 2026-11-02; owner 2026-11-13: OFF by default, because room talk near the counter was adding items to the cart; DIRECT_DEFAULT / the Voice settings switch turn it on): with hands-free on and a draft bill selected,
 * spoken dishes go straight into that bill, no "Hey Zonov" needed ("bill number 2 hai to bill number 2 me direct add").
 * Pure decision for one finished phrase heard while waiting (unit-tested in voiceDirect.test.ts):
 *  - dishes: added only when the phrase is clearly an order: at least one dish understood without a doubt, NOTHING left over
 *    that matched no dish ("the butter chicken was great" stays chatter), at least two words ("lassi" alone is ignored);
 *  - "bill 2 me ek butter chicken", "bill number 3 add two lassi", "table 4 me ..." aim at that open bill / table;
 *  - "place order" / "send to kitchen" (when the bill has dishes) and "undo" work without the wake phrase;
 *  - anything else is ignored silently (never a line, never a toast).
 */
import { detectCommand } from "./voiceCommands";
import { parseOrder, type VoiceMenu } from "./voiceParse";
import { normalizeModifiers } from "./voiceModifiers";
import type { DiningTable } from "./types";

export const DIRECT_DEFAULT = false;
const KEY = "pos.voiceDirect";
export function directOn(): boolean { try { const v = localStorage.getItem(KEY); return v === null ? DIRECT_DEFAULT : v === "1"; } catch { return DIRECT_DEFAULT; } }
export function setDirectOn(on: boolean) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ } }

export interface DirectLine { itemId: string; variantId: string | null; defaulted: boolean; qty: number; note: string | null; heard: string; issues: string[] }
export type DirectDecision =
  | { kind: "ignore"; why: string }
  | { kind: "add"; lines: DirectLine[]; billNo: number | null; table: { id: string; label: string } | null }
  | { kind: "command"; command: "place" | "kot" }
  | { kind: "undo" };

const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const UNDO = /^(undo|undo karo|wapas|hata do|galti|galat|remove that|cancel that)$/;
/** Table targeting the parser does not take as an order type: "table 4 me ...", "table number 4 pe ...". */
const TABLE_RE = /^\s*table\s*(?:number|no\.?)?\s*([a-z]{0,3}\s?\d{1,3})\s*(?:me|mein|main|pe|par|ke liye|ko|for|add|ka)?\b[\s,]*/i;

export function directDecision(text: string, menu: VoiceMenu, opts: { tables?: DiningTable[]; billHasLines: boolean; names?: string[] }): DirectDecision {
  const t = text.trim();
  const ws = words(t);
  if (!ws.length) return { kind: "ignore", why: "nothing heard" };
  if (UNDO.test(ws.join(" "))) return { kind: "undo" };
  const c = detectCommand(t, menu);
  if ((c.command === "place" || c.command === "kot") && !c.rest.trim()) return opts.billHasLines ? { kind: "command", command: c.command } : { kind: "ignore", why: "a command, but the bill is empty" };
  if (c.command === "clear") return { kind: "ignore", why: "cancel needs Hey Zonov (it asks first)" };
  if (ws.length < 2) return { kind: "ignore", why: "too short" };
  // "table 4 me ...": the table is the target, not an order type
  let rest = t;
  let table: { id: string; label: string } | null = null;
  const tm = TABLE_RE.exec(t);
  if (tm) {
    const label = tm[1].replace(/\s+/g, "").toUpperCase();
    const found = (opts.tables ?? []).find((x) => x.label.toUpperCase() === label || x.label.toUpperCase() === `T${label}`);
    if (!found) return { kind: "ignore", why: `no table ${label}` };
    table = { id: found.id, label: found.label };
    rest = t.slice(tm[0].length);
  }
  rest = rest.replace(/\b(add|add karo|daalo|dalo|me|mein)\b/gi, " ").replace(/\s{2,}/g, " ");
  const p = parseOrder(opts.names ? normalizeModifiers(rest, { names: opts.names }) : rest, menu, { tables: opts.tables });
  const lines = p.lines.filter((l) => !l.ask);
  if (!lines.length) return { kind: "ignore", why: "no dish" };
  if (p.unmatched.length) return { kind: "ignore", why: `words that are no dish: ${p.unmatched.map((u) => u.text).join(", ")}` };
  if (p.lines.some((l) => l.ask)) return { kind: "ignore", why: "a dish to choose (say Hey Zonov to choose it on the sheet)" };
  if (lines.some((l) => l.issues.some((i) => /not sure|dish/i.test(i)))) return { kind: "ignore", why: "not sure about a dish" };
  return {
    kind: "add", billNo: p.billNo, table,
    lines: lines.map((l) => ({ itemId: l.itemId, variantId: l.variantId, defaulted: l.defaulted, qty: l.qty, note: l.note, heard: l.heard, issues: l.issues })),
  };
}

/** At most `max` direct adds in `windowMs` (background talk must never flood a bill). */
export function rateOk(history: number[], now: number, max = 3, windowMs = 2000): boolean {
  return history.filter((t) => now - t < windowMs).length < max;
}
