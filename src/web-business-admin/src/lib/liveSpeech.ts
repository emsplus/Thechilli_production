/**
 * Thin wrapper over the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition) for live voice ordering.
 *
 * Browser notes (checked 2026-10):
 *  - Chrome desktop / Android, Edge, Samsung Internet: available; audio goes to the vendor's cloud recogniser, so it
 *    needs the internet. Chrome also has an on-device mode (`processLocally`, `SpeechRecognition.available()` /
 *    `install()`), which keeps working offline once the language pack is installed.
 *  - Safari macOS / iOS 14.5+: webkitSpeechRecognition (Siri dictation must be enabled); `continuous` sessions end
 *    by themselves after a pause and are restarted here.
 *  - Firefox: not available -> the till falls back to recording + the AI.
 *  - Chrome on Android repeats earlier final results inside later ones in continuous mode; `collapseFinals` drops them.
 * Chromium builds without the vendor speech service (some forks, headless test browsers) fail with "network" /
 * "service-not-allowed": the caller then falls back to recording.
 *
 * Hands-free (persistent) mode heals itself (docs/AI_VOICE_ORDERING.md "Wake mode failure modes"):
 *  - every session end is restarted; errors that keep coming back are retried with a capped exponential backoff
 *    (0, 0.5, 1, 2, 4, 8 s, then 10 s) and reported through onTrouble; after 5 failed restarts in a row the listener gives
 *    up calmly with onFail("sleeping") and the till re-arms it on focus / visible / online / permission change / a tap;
 *  - a WATCHDOG (1 s heartbeat) restarts a recogniser that never started (no onstart / onaudiostart within 3 s) or went
 *    silent without ending (no event for 70 s: Chrome after sleep, lid close or a device switch sometimes just stops);
 *  - start() throwing (InvalidStateError while the old one is still closing) is retried, never fatal, once the
 *    listener has started at least once; a microphone added or removed (devicechange) restarts the recogniser;
 *  - only "not-allowed" / "service-not-allowed" / "language-not-supported" end it (onFail "blocked" / "unsupported");
 *  - a vendor-service failure ("network") marks live recognition unusable for 60 s only (it was for the whole page
 *    before, so hands-free never came back without a reload), and coming back online clears it.
 * Every step is written to the diagnostics ring buffer (voiceDiag.ts): events only, never speech.
 */
import { diag } from "./voiceDiag";
import { micLog, micTranscript } from "./micLog";

/** Recognisers that are running right now (the mic debug header: must be 0 or 1). */
const running = new Set<object>();
export const runningRecognisers = () => running.size;

/** The parts of SpeechRecognition used here (not in every TS DOM lib yet). */
interface SRAlternative { transcript: string }
interface SRResult { isFinal: boolean; length: number; [i: number]: SRAlternative & { confidence?: number } }
interface SREvent { resultIndex: number; results: { length: number; [i: number]: SRResult } }
interface SR {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; processLocally?: boolean;
  onresult: ((e: SREvent) => void) | null; onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null; onstart: (() => void) | null;
  onaudiostart?: (() => void) | null; onsoundstart?: (() => void) | null; onspeechstart?: (() => void) | null; onspeechend?: (() => void) | null;
  /** Chrome contextual biasing (newer builds): the restaurant's dish names make the recogniser spell them right. */
  phrases?: unknown;
  start(): void; stop(): void; abort(): void;
}
interface SRCtor {
  new (): SR;
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

export function speechCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errors after which this browser's live recognition is not tried again this session (falls back to recording). */
const BROKEN = new Set(["network", "service-not-allowed", "language-not-supported", "bad-grammar"]);
/** In persistent (wait-for-"Hey Zonov") mode only these end listening for good; "network" and friends are retried with a backoff. */
// NEVER SLEEP (owner, 2026-11-02): "service-not-allowed" is transient in practice (Chrome's service busy / throttled) and is
// retried like "network"; only a refused microphone and a language the browser cannot do end listening.
const FATAL = new Set(["not-allowed", "language-not-supported", "bad-grammar"]);
/** Live recognition failed with a vendor-service error: not tried again before this time (ms). Was "for the whole page". */
let brokenUntil = 0;
const BROKEN_FOR_MS = 60_000;
if (typeof window !== "undefined") window.addEventListener("online", () => { if (brokenUntil) diag("online: live speech usable again"); brokenUntil = 0; });
/** The browser's own error code of the last failed start ("not-allowed", "network", "start-threw: InvalidStateError"...): shown next to "tap the mic" so a support question has a real reason. */
export let lastSpeechError = "";
export const liveSpeechUsable = () => Date.now() >= brokenUntil && !!speechCtor();
/** Test hook: forget an earlier vendor-service failure. */
export const resetSpeechBroken = () => { brokenUntil = 0; };
/** Hands-free watchdog limits (exported for the unit tests). */
// startGraceMs: no onstart / audiostart within 2 s of start(): destroy and recreate (owner: "mic start")
export const WATCHDOG = { tickMs: 1000, startGraceMs: 2000, silentMaxMs: 70_000, giveUpAfter: 5,
  /** Speech was detected (speechstart) but no result came for this long: the recogniser is deaf, replace it (QA B18). */
  deafMs: 15_000,
  /** The first utterance after a start gets no result at all: a deaf start, recreated sooner. */
  deafFirstMs: 3_000,
  /** A hands-free session older than this is replaced at the next quiet moment: long Chrome sessions degrade (QA B18). */
  recycleMs: 240_000,
  /** The self-check: the bookkeeping must agree (one running recogniser, the one we hold). */
  selfCheckMs: 15_000 };
// test hook (specs shorten the watchdog): window.__POS_VOICE_WATCHDOG = { startGraceMs, silentMaxMs }
if (typeof window !== "undefined") { const o = (window as unknown as { __POS_VOICE_WATCHDOG?: Partial<typeof WATCHDOG> }).__POS_VOICE_WATCHDOG; if (o) Object.assign(WATCHDOG, o); }
/** Dish names the recogniser should expect (Chrome contextual biasing where supported; ignored elsewhere). */
let biasPhrases: string[] = [];
export const setSpeechPhrases = (names: string[]) => { biasPhrases = names.slice(0, 200); };

/**
 * True when the browser can recognise `lang` ON THE DEVICE (Chrome's processLocally): voice ordering then works
 * offline. Only asked when the user taps the mic offline (the call is not free and some test browsers lack it).
 */
export async function canRecogniseOffline(lang: string): Promise<boolean> {
  const C = speechCtor();
  if (!C || typeof C.available !== "function" || Date.now() < brokenUntil) return false;
  try {
    const r = await Promise.race([C.available({ langs: [lang], processLocally: true }), new Promise<string>((ok) => setTimeout(() => ok("timeout"), 1500))]);
    return r === "available";
  } catch { return false; }
}

/** Android Chrome repeats earlier finals inside later ones ("two lamb", "two lamb karahi"): keep only the longest. */
export function collapseFinals(finals: string[]): string[] {
  const out: string[] = [];
  for (const f of finals.map((x) => x.trim()).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (prev && f.toLowerCase().startsWith(prev.toLowerCase())) out[out.length - 1] = f;
    else if (!(prev && prev.toLowerCase().startsWith(f.toLowerCase()))) out.push(f);
  }
  return out;
}

export interface LiveUpdate { finalText: string; interim: string;
  /** The recogniser's OTHER guesses for its newest result (maxAlternatives 5): "hey zonov" may be the 2nd guess (QA B18). */
  alternatives?: string[] }
export type LiveFailure = "blocked" | "no-mic" | "unsupported" | "sleeping";

/**
 * One listening session: keeps restarting the recogniser (sessions end after a pause) until stop(), and reports the
 * whole transcript so far each time (`finalText` = settled speech, `interim` = words still being recognised).
 */
export class LiveListener {
  private rec: SR | null = null;
  private committed: string[] = []; // finals of earlier recogniser sessions
  private finals: string[] = [];
  private interim = "";
  private active = false;
  private heardAnything = false;
  private restarts = 0;
  private sessionStart = 0;
  private sessionErr: string | null = null;
  private trouble: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastEvent = 0; // last onstart / onaudiostart / onsoundstart / onspeechstart / onresult / onend / onerror
  private alive = false; // the current recogniser reported that it started
  private everStarted = false;
  private failedRestarts = 0; // restarts in a row that never reached onstart / a result
  private onDevice: (() => void) | null = null;
  /** While true, text from finished recogniser sessions is dropped instead of kept (the background wait never accumulates speech). */
  forget = false;

  constructor(private readonly opts: {
    lang: string; processLocally?: boolean;
    /** Never give up: a recogniser that ends (Chrome ends sessions after a pause) is restarted indefinitely, with a backoff while it keeps failing. */
    persistent?: boolean;
    /** Persistent mode: the recogniser keeps failing ("network", "audio-capture"...: code) or is healthy again (null). */
    onTrouble?: (code: string | null) => void;
    /** The recogniser REALLY started (Chrome sent onstart / audiostart) or stopped: the chip says "Listening" only after true. */
    onAlive?: (alive: boolean) => void;
    onUpdate: (u: LiveUpdate) => void;
    /** Could not listen at all (before any speech): the caller falls back. */
    onFail: (why: LiveFailure) => void;
    /** Listening ended for good (stop(), or the recogniser gave up after speech was heard). */
    onEnd: (u: LiveUpdate) => void;
  }) {}

  private alts: string[] = [];
  /** When this listener last got ANY result (across sessions): the gap fallback compares it with the speech the mic detector heard. */
  anyResultAt = 0;
  /** When this listener last got a FINAL result (the gap fallback: interim fragments alone are a gap). */
  finalAt = 0;
  private results = 0;      // results of the current recogniser session (the debug line)
  private lastResultAt = 0;
  private lastSpeechAt = 0;
  private lastSelfCheck = 0;
  /** One line per recogniser session for the mic debug box: how long it was really alive and how many results it gave. */
  private sessionLine(why: string) {
    micLog("event", `session ended (${why}): alive ${this.alive ? Date.now() - this.sessionStart : 0} ms, ${this.results} results`);
  }
  get text(): LiveUpdate {
    return { finalText: [...this.committed, ...collapseFinals(this.finals)].join(", "), interim: this.interim.trim(), ...(this.alts.length ? { alternatives: this.alts } : {}) };
  }

  /** Must be called from the tap handler itself (Safari only starts recognition inside a user gesture). */
  start(): boolean {
    const C = speechCtor();
    if (!C) return false;
    this.active = true;
    diag(this.opts.persistent ? "wake: start" : "live: start");
    if (this.opts.persistent) this.arm(C);
    return this.spawn(C);
  }

  /** Persistent mode: the heartbeat and the device-change hook (both removed by stop / abort / fail). */
  private arm(C: SRCtor) {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.active || this.restartTimer) return;
      const now = Date.now();
      if (!this.rec) { this.retry(C, "no recogniser"); return; }
      if (!this.alive && now - this.sessionStart > WATCHDOG.startGraceMs) { micLog("error", `start failed: no onstart / audiostart within ${WATCHDOG.startGraceMs} ms`); this.retry(C, "never started"); return; }
      // a quiet room is no failure: a recogniser that started and then heard nothing for a while is replaced without counting
      // towards "sleeping" (before, 5 quiet periods in a row put hands-free to sleep; QA B14)
      if (this.alive && now - this.lastEvent > WATCHDOG.silentMaxMs) { this.retry(C, "silent", true); return; }
      // deaf: the microphone hears speech, the recogniser returns nothing (it works again after a reload: replace it now)
      // ... and only 3 s for the FIRST utterance after a start with no result at all (live log: a deaf start)
      if (this.alive && this.results === 0 && this.lastSpeechAt > 0 && now - this.lastSpeechAt > WATCHDOG.deafFirstMs) { micLog("error", "deaf start: speech heard, no result at all"); this.retry(C, "deaf start", true); return; }
      if (this.alive && this.lastSpeechAt > this.lastResultAt && now - this.lastSpeechAt > WATCHDOG.deafMs) { this.retry(C, `deaf: speech heard but no result for ${Math.round((now - this.lastSpeechAt) / 1000)} s`, true); return; }
      // long sessions degrade: a fresh recogniser at a quiet moment
      if (this.alive && now - this.sessionStart > WATCHDOG.recycleMs && now - this.lastEvent > 3000 && !this.interim) { this.retry(C, `fresh session after ${Math.round((now - this.sessionStart) / 60_000)} min`, true); return; }
      // self-check: exactly the recogniser we hold is running
      if (now - this.lastSelfCheck > WATCHDOG.selfCheckMs) {
        this.lastSelfCheck = now;
        // only OUR recogniser decides (another listener, e.g. a Train / Test in Voice settings, may run for a moment)
        if (running.size > 1) micLog("event", `self-check: ${running.size} recognisers running`);
        if (!running.has(this.rec)) { micLog("error", "self-check: our recogniser is not running"); this.retry(C, "self-check", true); }
      }
    }, WATCHDOG.tickMs);
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (md?.addEventListener) {
      this.onDevice = () => { diag("devicechange"); if (this.active && !this.restartTimer) setTimeout(() => this.active && this.retry(C, "device changed", true), 500); };
      md.addEventListener("devicechange", this.onDevice);
    }
  }

  private disarm() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (this.onDevice && md?.removeEventListener) md.removeEventListener("devicechange", this.onDevice);
    this.onDevice = null;
  }

  /** Throw the current recogniser away (no callbacks) and start a fresh one, with the backoff while restarts keep failing. */
  private retry(C: SRCtor, why: string, clean = false) {
    this.sessionLine(why);
    micLog("event", `recreate: ${why}`);
    const old = this.rec;
    this.rec = null;
    if (old) { running.delete(old); old.onresult = null; old.onend = null; old.onerror = null; old.onstart = null; try { old.abort(); } catch { /* already stopped */ } }
    if (!this.forget) this.committed = [...this.committed, ...collapseFinals(this.finals), ...(this.interim.trim() ? [this.interim.trim()] : [])];
    this.finals = []; this.interim = "";
    if (!clean) this.failedRestarts++;
    diag("watchdog: restart", `${why} (#${this.failedRestarts})`);
    this.schedule(C);
  }

  /**
   * Next recogniser after `failedRestarts` failures in a row: at once, then 250, 500 ms, 1 s; 3 s while it keeps failing; FOREVER
   * (owner, 2026-11-02: the mic must never sleep; there is no terminal state while the page is open and the mic is allowed).
   */
  private schedule(C: SRCtor) {
    const n = this.failedRestarts;
    const delay = n <= 1 ? 0 : n <= 4 ? Math.min(250 * 2 ** (n - 2), 1000) : 3000;
    micLog("event", `restart scheduled in ${delay} ms (failed restarts in a row: ${this.failedRestarts})`);
    if (this.failedRestarts >= 3 && this.trouble !== "restarting") { this.trouble = lastSpeechError || "restarting"; this.opts.onTrouble?.(this.trouble); }
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.active) this.spawn(C); }, delay);
  }

  private beat = (rec: SR, ev: string) => {
    if (this.rec !== rec) return;
    this.lastEvent = Date.now();
    if (!this.alive) { this.alive = true; this.everStarted = true; diag(`sr: ${ev}`); micLog("event", `really listening (${ev} ${Date.now() - this.sessionStart} ms after start)`); this.opts.onAlive?.(true); }
  };

  private spawn(C: SRCtor): boolean {
    let rec: SR;
    try {
      rec = new C();
      rec.lang = this.opts.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 5; // the wake phrase is looked for in every guess, not only the first (QA B18)
      if (this.opts.processLocally && "processLocally" in rec) rec.processLocally = true;
    } catch { this.fail("unsupported"); return false; }
    this.sessionStart = Date.now(); this.sessionErr = null; this.alive = false; this.lastEvent = Date.now();
    this.opts.onAlive?.(false);
    this.results = 0; this.lastResultAt = 0; this.lastSpeechAt = 0; this.alts = [];
    if (biasPhrases.length && "phrases" in rec) {
      try {
        const P = (window as unknown as { SpeechRecognitionPhrase?: new (p: string, boost: number) => unknown }).SpeechRecognitionPhrase;
        if (P) rec.phrases = biasPhrases.map((p) => new P(p, 5));
      } catch { /* biasing is optional */ }
    }
    rec.onstart = () => { micLog("event", "onstart"); this.beat(rec, "start"); };
    rec.onaudiostart = () => { micLog("event", "audiostart"); this.beat(rec, "audiostart"); };
    rec.onsoundstart = () => { micLog("event", "soundstart"); this.beat(rec, "soundstart"); };
    rec.onspeechstart = () => { micLog("event", "speechstart"); if (this.rec === rec) this.lastSpeechAt = Date.now(); this.beat(rec, "speechstart"); };
    rec.onspeechend = () => { if (this.rec === rec) micLog("event", "speechend"); };
    rec.onresult = (e) => {
      this.beat(rec, "result");
      if (this.failedRestarts) this.failedRestarts = 0;
      if (this.trouble !== null) { this.trouble = null; this.opts.onTrouble?.(null); }
      const finals: string[] = [];
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) finals.push(t); else interim += (interim ? " " : "") + t.trim();
      }
      this.finals = finals;
      this.interim = interim;
      const last = e.results[e.results.length - 1];
      if (last) micTranscript(last[0]?.transcript ?? "", last.isFinal, last[0]?.confidence);
      this.results++; this.lastResultAt = Date.now(); this.anyResultAt = this.lastResultAt;
      if (last?.isFinal) this.finalAt = this.lastResultAt;
      const alts: string[] = [];
      for (let k = 1; last && k < last.length; k++) { const t = last[k]?.transcript?.trim(); if (t) alts.push(t); }
      this.alts = alts;
      if (alts.length) micLog("event", `other guesses: ${alts.map((a) => `“${a}”`).join(", ")}`);
      if (finals.length || interim) this.heardAnything = true;
      this.opts.onUpdate(this.text);
    };
    rec.onerror = (e) => {
      const code = e.error;
      this.lastEvent = Date.now();
      micLog("error", `error ${code}${e.message ? ` (${e.message})` : ""}`);
      if (code === "no-speech" || code === "aborted") return; // a pause: onend restarts
      lastSpeechError = String(code);
      diag("sr: error", code);
      if (this.opts.persistent && !FATAL.has(code)) { this.sessionErr = String(code); return; } // onend restarts it, slowly while it keeps failing
      if (BROKEN.has(code)) { brokenUntil = Date.now() + BROKEN_FOR_MS; diag("live speech paused", `${code} for 60 s`); }
      if (this.opts.persistent) this.disarm();
      this.active = false;
      if (!this.heardAnything) this.fail(code === "not-allowed" ? "blocked" : code === "audio-capture" ? "no-mic" : "unsupported");
    };
    rec.onend = () => {
      running.delete(rec);
      if (this.rec !== rec) return;
      micLog("event", "onend");
      this.sessionLine("onend");
      this.lastEvent = Date.now();
      if (this.opts.persistent && this.active) {
        // a session that never started or died at once with an error counts as a failed restart (drives the backoff)
        const failed = !this.alive || (!!this.sessionErr && Date.now() - this.sessionStart < 2000);
        this.failedRestarts = failed ? this.failedRestarts + 1 : 0;
        if (failed) diag("sr: end (failed)", this.sessionErr ?? "no start"); else diag("sr: end");
        const settled = !this.forget && !!this.interim.trim();
        if (!this.forget) this.committed = [...this.committed, ...collapseFinals(this.finals), ...(this.interim.trim() ? [this.interim.trim()] : [])];
        this.finals = []; this.interim = "";
        if (settled) this.opts.onUpdate(this.text); // the unfinished words are final now: a "place order" / "done" in them counts
        if (!this.active) return; // the caller stopped listening on those words
        if (this.failedRestarts === 0 && this.trouble !== null) { this.trouble = null; this.opts.onTrouble?.(null); }
        this.rec = null;
        if (this.failedRestarts === 0) { this.spawn(C); return; }
        this.schedule(C);
        return;
      }
      // settle what this session heard (an interim that never became final still counts once the session is over)
      const settled = !this.forget && !!this.interim.trim();
      if (!this.forget) this.committed = [...this.committed, ...collapseFinals(this.finals), ...(this.interim.trim() ? [this.interim.trim()] : [])];
      this.finals = []; this.interim = "";
      if (this.active && this.restarts < 30) {
        this.restarts++;
        // the restart is quiet until the next words: tell the caller now that the unfinished words are final (a "place order" in them counts)
        if (settled) this.opts.onUpdate(this.text);
        if (!this.active) return; // the caller stopped listening on those words
        if (this.spawn(C)) return;
      }
      this.active = false;
      this.rec = null;
      this.opts.onEnd(this.text);
    };
    this.rec = rec;
    running.add(rec);
    micLog("event", `${this.opts.persistent ? "start (hands-free)" : "start"} lang=${this.opts.lang}`);
    try { rec.start(); } catch (err) {
      running.delete(rec);
      lastSpeechError = `start-threw: ${(err as Error)?.name ?? "error"}`;
      diag("sr: start threw", (err as Error)?.name ?? "error");
      rec.onend = null; rec.onerror = null; rec.onresult = null;
      try { rec.abort(); } catch { /* never started */ }
      this.rec = null;
      // hands-free: a throw is a race with a recogniser that is still closing (Chrome: InvalidStateError right after a stop /
      // abort, e.g. the order sheet's own recogniser after an order was sent), retried with the backoff, also for a fresh
      // listener (owner bug 2026-11-02: it gave up at once and "Hey Zonov" stopped working after a completed order)
      if (this.opts.persistent && this.active) { this.failedRestarts++; this.schedule(C); return true; }
      // a tapped session right after the background (hands-free) recogniser was aborted: the same race; a few quick retries
      // before falling back to recording (QA soak: tapping the mic while "Hey Zonov" waited went to recording)
      if (this.active && this.startRetries < 3) {
        this.startRetries++;
        this.restartTimer = setTimeout(() => { this.restartTimer = null; if (this.active) this.spawn(C); }, 300);
        return true;
      }
      this.fail("unsupported");
      return false;
    }
    return true;
  }

  private startRetries = 0; // tapped sessions: start() throws retried (a recogniser still closing)
  private failed = false;
  private fail(why: LiveFailure) {
    if (this.failed) return;
    this.failed = true;
    this.active = false;
    this.disarm();
    diag("live: fail", why);
    const r = this.rec;
    this.rec = null;
    if (r) { running.delete(r); r.onend = null; try { r.abort(); } catch { /* already stopped */ } }
    // a restart that fails after speech was heard (Safari without a fresh tap) just ends the session normally
    if (this.heardAnything) this.opts.onEnd(this.text);
    else this.opts.onFail(why);
  }

  /** Stop listening; the last words still arrive as a final result, then onEnd fires. */
  stop() {
    this.active = false;
    this.disarm();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; this.opts.onEnd(this.text); return; }
    const r = this.rec;
    if (!r) return;
    try { r.stop(); } catch { r.onend?.(); }
  }

  /** Stop without waiting for the last words; no more callbacks. */
  abort() {
    this.active = false;
    this.disarm();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const r = this.rec;
    this.rec = null;
    if (r) { running.delete(r); micLog("event", "abort"); r.onresult = null; r.onend = null; r.onerror = null; try { r.abort(); } catch { /* already stopped */ } }
  }
}
