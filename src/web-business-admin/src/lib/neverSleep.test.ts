/**
 * NEVER SLEEP soak (owner, 2026-11-02; docs/VOICE_QA_REPORT.md): 4 hours of a hands-free listener with fake timers and a hostile
 * Chrome-like recogniser: no-speech ends every ~8 s, onend without an error, "aborted", "network", "service-not-allowed",
 * "audio-capture", silent deaths, starts that throw, starts that never report, device changes. Phrases are spoken at random
 * times: the recogniser hears those it is listening for; the ones that fall into a restart gap go through the gap fallback
 * (gapDecision: the server's speech-to-text). Asserts: never a terminal state, a new recogniser after every end, every phrase
 * processed exactly once, and reports the deaf windows.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

class FakeSR {
  static made: FakeSR[] = [];
  static throwNext = 0;
  static silentNext = 0;
  lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null; onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null; onstart: (() => void) | null = null; onaudiostart: (() => void) | null = null;
  started = false; listening = false; aborted = false;
  constructor() { FakeSR.made.push(this); }
  start() {
    if (FakeSR.throwNext > 0) { FakeSR.throwNext--; const e = new Error("busy"); e.name = "InvalidStateError"; throw e; }
    this.started = true;
    if (FakeSR.silentNext > 0) { FakeSR.silentNext--; return; } // never reports onstart
    setTimeout(() => { if (this.started) { this.listening = true; this.onstart?.(); this.onaudiostart?.(); } }, 50);
  }
  stop() { this.started = false; this.listening = false; setTimeout(() => this.onend?.(), 0); }
  abort() { this.started = false; this.listening = false; this.aborted = true; }
  finals: string[] = []; // a Chrome session keeps all its results
  hear(t: string) { this.finals.push(t); const list = this.finals.map((x) => Object.assign([{ transcript: x }], { isFinal: true })); this.onresult?.({ resultIndex: 0, results: Object.assign(list, { length: list.length }) }); }
}

let devListener: (() => void) | null = null;
let mod: typeof import("./liveSpeech");
let guard: typeof import("./micGuard");
beforeAll(async () => {
  vi.stubGlobal("window", { SpeechRecognition: FakeSR, addEventListener: () => {} });
  vi.stubGlobal("navigator", { mediaDevices: { addEventListener: (_: string, f: () => void) => { devListener = f; }, removeEventListener: () => { devListener = null; } } });
  mod = await import("./liveSpeech");
  guard = await import("./micGuard");
});
beforeEach(() => { vi.useFakeTimers(); FakeSR.made = []; });
afterEach(() => { vi.useRealTimers(); });

test("4 hours of hostile recogniser events: never sleeps, every phrase processed exactly once", () => {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const processed = new Map<string, number>();
  const seen = new Set<string>();
  const cb = {
    onUpdate: (u: { finalText: string }) => {
      // each new final segment is one phrase ("p123")
      // count each phrase the first time it appears in the (growing) transcript; a repeat of the same update counts once
      for (const m of u.finalText.matchAll(/p\d+/g)) if (!seen.has(m[0])) { seen.add(m[0]); processed.set(m[0], (processed.get(m[0]) ?? 0) + 1); }
    },
    onFail: vi.fn(), onEnd: vi.fn(), onTrouble: vi.fn(),
  };
  const l = new mod.LiveListener({ lang: "en-IN", persistent: true, ...cb });
  l.forget = false;
  const startClock = Date.now(); // the listener stamps results with Date.now() (fake clock); the loop counts from 0
  l.start();
  const HOURS = 4, STEP = 100;
  const end = HOURS * 3_600_000;
  let t = 0, phrase = 0, viaGap = 0, viaRec = 0;
  let deafSince: number | null = null;
  const deaf: number[] = [];
  let nextNoSpeech = 8000;
  const gapClips: number[] = [];
  const pendingGap: { id: string; start: number; end: number }[] = [];
  for (; t < end; t += STEP) {
    vi.advanceTimersByTime(STEP);
    const cur = FakeSR.made.at(-1)!;
    const listening = !!cur && cur.listening;
    if (!listening && deafSince === null) deafSince = t;
    if (listening && deafSince !== null) { deaf.push(t - deafSince); deafSince = null; }
    // Chrome: a no-speech end every ~8 s of quiet, and other hostile events now and then
    if (listening && t >= nextNoSpeech) { nextNoSpeech = t + 8000; cur.onerror?.({ error: "no-speech" }); cur.listening = false; cur.started = false; cur.onend?.(); continue; }
    const r = rnd();
    if (listening && r < 0.0005) { cur.listening = false; cur.started = false; cur.onend?.(); continue; }                     // onend without onerror
    if (listening && r < 0.0008) { cur.onerror?.({ error: "aborted" }); cur.listening = false; cur.started = false; cur.onend?.(); continue; }
    if (listening && r < 0.0011) { cur.onerror?.({ error: "network" }); cur.listening = false; cur.started = false; cur.onend?.(); continue; }
    if (listening && r < 0.0012) { cur.onerror?.({ error: "service-not-allowed" }); cur.listening = false; cur.started = false; cur.onend?.(); continue; }
    if (listening && r < 0.0013) { cur.onerror?.({ error: "audio-capture" }); cur.listening = false; cur.started = false; cur.onend?.(); continue; }
    if (listening && r < 0.00135) { cur.listening = false; cur.started = false; continue; }                                   // silent death
    if (r > 0.9997) FakeSR.throwNext = 2;
    if (r > 0.99955 && r <= 0.9997) FakeSR.silentNext = 1;
    if (r > 0.9994 && r <= 0.99955) devListener?.();
    // a phrase spoken (about every 25 s): heard by the recogniser if it is listening, else it is a gap utterance
    if (rnd() < STEP / 25_000 || (!listening && rnd() < 0.05)) { // ... and on purpose inside restart gaps
      const id = `p${++phrase}`;
      if (listening) { cur.hear(id); viaRec++; nextNoSpeech = t + 8000; } else pendingGap.push({ id, start: t, end: t + 800 });
    }
    // the gap fallback: 1.5 s after the speech ended, when the recogniser produced nothing for it
    for (const g of [...pendingGap]) {
      if (t < g.end + 1500) continue;
      pendingGap.splice(pendingGap.indexOf(g), 1);
      const d = guard.gapDecision({ start: g.start, end: g.end }, { lastResultAt: l.anyResultAt ? l.anyResultAt - startClock : -1, now: t, recent: gapClips });
      if (d.send) { gapClips.push(t); processed.set(g.id, (processed.get(g.id) ?? 0) + 1); viaGap++; }
    }
  }
  expect(cb.onFail).not.toHaveBeenCalled(); // never a terminal "sleeping"
  expect(FakeSR.made.length).toBeGreaterThan(1500); // a new recogniser after every end
  const missing = Array.from({ length: phrase }, (_, i) => `p${i + 1}`).filter((id) => processed.get(id) !== 1 && !pendingGap.some((g) => g.id === id));
  expect(missing, "every phrase processed exactly once").toEqual([]);
  deaf.sort((a, b) => a - b);
  const p = (q: number) => deaf[Math.min(deaf.length - 1, Math.floor(deaf.length * q))];
  // the report (docs/VOICE_QA_REPORT.md): the deaf windows of the simulated recogniser and how the phrases were heard
  console.log(`NEVER-SLEEP SOAK 4h: ${FakeSR.made.length} recognisers, ${deaf.length} deaf windows: median ${p(0.5)} ms, p95 ${p(0.95)} ms, p99 ${p(0.99)} ms, max ${deaf.at(-1)} ms; phrases ${phrase}: recogniser ${viaRec}, gap fallback ${viaGap}`);
  expect(deaf.at(-1)!).toBeLessThanOrEqual(10_000);
  l.abort();
});
