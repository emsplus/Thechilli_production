/**
 * Voice diagnostics: the last 50 microphone / recogniser EVENTS (never audio, never what was said), so the owner can send
 * what happened when hands-free stopped listening. Shown with ?voicedebug=1 on the till and copyable as text.
 */
import { micLog } from "./micLog";

export interface DiagEvent { t: number; ev: string; detail?: string }
const MAX = 50;
const buf: DiagEvent[] = [];
const subs = new Set<() => void>();
let snapshot: DiagEvent[] = [];

/** Records one event. `detail` must never carry speech: codes, counts and states only. */
export function diag(ev: string, detail?: string | number): void {
  buf.push({ t: Date.now(), ev, ...(detail !== undefined ? { detail: String(detail).slice(0, 80) } : {}) });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  snapshot = [...buf];
  subs.forEach((f) => f());
  micLog(/error|threw|fail/.test(ev) ? "error" : "event", `${ev}${detail !== undefined ? ` ${detail}` : ""}`); // the mic debug box (testing phase)
}
export const diagEvents = (): DiagEvent[] => snapshot;
export const subscribeDiag = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const clearDiag = () => { buf.length = 0; snapshot = []; subs.forEach((f) => f()); };
/** Plain text for "Copy": one line per event, oldest first, with the browser's user agent at the top. */
export function diagText(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return [`voice diagnostics ${new Date().toISOString()} ${ua}`, ...snapshot.map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.ev}${e.detail ? ` ${e.detail}` : ""}`)].join("\n");
}
