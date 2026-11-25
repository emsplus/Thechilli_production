/**
 * TESTING PHASE: the "Mic debug" log next to the mic (owner, 2026-11-02). Everything the microphone and the recogniser do, in
 * plain text, so the owner can see why "Hey Zonov" did not wake or why the mic stopped: transcripts (interim / final, with the
 * confidence when the browser gives one), each wake decision, and every lifecycle event and error code.
 * On this device only: a ring buffer in memory (MAX lines), never audio, never sent anywhere (Copy / Download are the person's
 * own action). Interim transcripts are throttled to about 5 a second so logging never slows the mic.
 * MIC_DEBUG_DEFAULT is the single switch to turn it default-off (or remove it) before real customers. Unit-tested in micLog.test.ts.
 */
export const MIC_DEBUG_DEFAULT = true;
const SHOW_KEY = "pos.micDebug";
export const MIC_LOG_MAX = 200;
export const INTERIM_EVERY_MS = 200;

export type MicKind = "interim" | "final" | "wake" | "nowake" | "event" | "error";
export interface MicLine { t: number; kind: MicKind; text: string }

let buf: MicLine[] = [];
let snapshot: MicLine[] = [];
const subs = new Set<() => void>();
let lastInterim = 0;
let pendingInterim: MicLine | null = null;
let interimTimer: ReturnType<typeof setTimeout> | null = null;
let clock = () => Date.now();
/** Test hook. */
export const setMicLogClock = (f: () => number) => { clock = f; };

function push(l: MicLine) {
  buf.push(l);
  if (buf.length > MIC_LOG_MAX) buf = buf.slice(buf.length - MIC_LOG_MAX);
  snapshot = buf;
  subs.forEach((f) => f());
}

/** One line. Interims are throttled (the newest of a burst is kept). */
export function micLog(kind: MicKind, text: string) {
  const t = clock();
  const line = { t, kind, text: text.slice(0, 300) };
  if (kind !== "interim") { if (pendingInterim) { push(pendingInterim); pendingInterim = null; } push(line); return; }
  if (t - lastInterim >= INTERIM_EVERY_MS) { lastInterim = t; push(line); return; }
  pendingInterim = line;
  if (!interimTimer) interimTimer = setTimeout(() => { interimTimer = null; if (pendingInterim) { lastInterim = clock(); push(pendingInterim); pendingInterim = null; } }, INTERIM_EVERY_MS);
}
/** A transcript as the recogniser returned it. */
export const micTranscript = (text: string, final: boolean, confidence?: number) =>
  micLog(final ? "final" : "interim", `${final ? "final" : "interim"}: “${text}”${typeof confidence === "number" && confidence > 0 ? ` (confidence ${confidence.toFixed(2)})` : ""}`);

export const micLines = (): MicLine[] => snapshot;
export const subscribeMicLog = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function clearMicLog() { buf = []; snapshot = []; pendingInterim = null; subs.forEach((f) => f()); }

const hhmmss = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`; };
export const formatLine = (l: MicLine) => `${hhmmss(l.t)} ${l.kind.toUpperCase().padEnd(7)} ${l.text}`;
/** Plain text for Copy / Download: a header, then one line each, oldest first. */
export function micLogText(header: string): string {
  return [header, ...snapshot.map(formatLine)].join("\n");
}

export function micDebugShown(): boolean {
  try { const v = localStorage.getItem(SHOW_KEY); return v === null ? MIC_DEBUG_DEFAULT : v === "1"; } catch { return MIC_DEBUG_DEFAULT; }
}
export function setMicDebugShown(on: boolean) { try { localStorage.setItem(SHOW_KEY, on ? "1" : "0"); } catch { /* private mode */ } showSubs.forEach((f) => f()); }
const showSubs = new Set<() => void>();
export const subscribeMicDebugShown = (f: () => void) => { showSubs.add(f); return () => { showSubs.delete(f); }; };
