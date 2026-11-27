/**
 * NEVER SLEEP, step 2 (owner, 2026-11-02): one persistent microphone stream next to the speech recogniser.
 * - A light voice-activity detector (AnalyserNode RMS every 50 ms, an adaptive noise floor, hysteresis) says "speech started" at
 *   once, independently of the recogniser (the mic chip can react within ~100 ms).
 * - A rolling recording (MediaRecorder, 250 ms slices; the first slice holds the container header) keeps the last seconds, so an
 *   utterance (1 s of pre-roll + until 600 ms of silence, at most 12 s) can be handed to the server's speech-to-text when the
 *   recogniser produced NOTHING for it (a restart gap, a deaf recogniser): `onUtterance` -> the caller decides (gapDecision).
 * - A heartbeat every 5 s: the track must be live and not muted, the audio graph running and frames arriving; else everything is
 *   rebuilt. A microphone plugged in / out rebuilds it within 1 s. A screen wake lock is held while it runs.
 * Released on stop() (Reset, hands-free off, tab hidden, leaving the page). Nothing is sent by this module; never audio is stored.
 * Pure parts (VadState, gapDecision) are unit-tested in micGuard.test.ts.
 */
import { getUserMediaQueued } from "./gum";
import { micLog } from "./micLog";

export interface Utterance { start: number; end: number; clip: Blob | null }

/** The voice-activity decision on RMS samples (pure). */
export class VadState {
  floor = 0.01;
  speaking = false;
  start = 0;
  private above = 0;
  private quietSince = 0;
  constructor(private readonly opts = { onRatio: 3, offRatio: 2, minOn: 0.012, hangMs: 600, framesOn: 2 }) {}
  /** One RMS sample at time t: "start" / "end" when the state changes, else null. */
  feed(rms: number, t: number): "start" | "end" | null {
    const on = Math.max(this.floor * this.opts.onRatio, this.opts.minOn);
    const off = Math.max(this.floor * this.opts.offRatio, this.opts.minOn * 0.7);
    if (!this.speaking) {
      this.floor = this.floor * 0.95 + Math.min(rms, on) * 0.05; // the room's noise, learned while nobody speaks
      if (rms > on) { if (++this.above >= this.opts.framesOn) { this.speaking = true; this.start = t; this.quietSince = 0; this.above = 0; return "start"; } } else this.above = 0;
      return null;
    }
    if (rms < off) { if (!this.quietSince) this.quietSince = t; if (t - this.quietSince >= this.opts.hangMs) { this.speaking = false; return "end"; } } else this.quietSince = 0;
    return null;
  }
}

/** The server fallback for an utterance: only when the recogniser gave nothing for it, it was long enough, and within the budget. */
/**
 * `lastResultAt`: the recogniser's last FINAL result (live log 2026-11-02: interim fragments "hey" / "hey Jon" that never became
 * a final or a wake are no proof it heard the speech; that is a gap too).
 */
export function gapDecision(u: { start: number; end: number }, o: { lastResultAt: number; now: number; recent: number[]; maxPer10Min?: number }): { send: boolean; why: string } {
  const dur = u.end - u.start;
  if (dur < 400) return { send: false, why: `too short (${dur} ms)` };
  if (o.lastResultAt >= u.start - 200) return { send: false, why: "the recogniser gave a final for it" };
  if (o.now - u.end < 1200) return { send: false, why: "waiting for the recogniser" };
  if (o.recent.filter((t) => o.now - t < 600_000).length >= (o.maxPer10Min ?? 20)) return { send: false, why: "budget: 20 clips per 10 min" };
  return { send: true, why: `no recogniser result for ${dur} ms of speech` };
}

export class MicGuard {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private header: Blob | null = null;
  private chunks: { t: number; b: Blob }[] = [];
  private vad = new VadState();
  private tick: ReturnType<typeof setInterval> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private frames = 0;
  private lastFrames = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private onDevice = () => { micLog("event", "mic guard: device change, rebuilding"); setTimeout(() => void this.rebuild("device change"), 300); };
  private onVis = () => { if (!document.hidden && this.running) void this.lockScreen(); };
  running = false;

  constructor(private readonly cb: { onSpeech?: (on: boolean) => void; onUtterance?: (u: Utterance) => void;
    /** The audio graph is ready (the offline wake detector attaches here) / goes away. */
    onGraph?: (ctx: AudioContext, src: MediaStreamAudioSourceNode) => void; onRelease?: () => void }) {}

  async start(): Promise<boolean> {
    if (this.running) return true;
    this.running = true;
    try {
      this.stream = await getUserMediaQueued({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { this.running = false; micLog("error", `mic guard: no stream (${(e as Error)?.name ?? "error"})`); return false; }
    if (!this.running) { this.release(); return false; }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.cb.onGraph?.(this.ctx, src);
    } catch { micLog("error", "mic guard: no audio graph"); }
    try {
      this.rec = new MediaRecorder(this.stream, { mimeType: MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined, audioBitsPerSecond: 32000 });
      this.header = null; this.chunks = [];
      this.rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        if (!this.header) { this.header = e.data; return; }
        const t = Date.now();
        this.chunks.push({ t, b: e.data });
        const keepFrom = this.vad.speaking ? Math.min(this.vad.start - 1000, t - 12_000) : t - 4000;
        while (this.chunks.length && this.chunks[0].t < keepFrom) this.chunks.shift();
      };
      this.rec.start(250);
    } catch { micLog("error", "mic guard: no rolling recording (the gap fallback is off)"); }
    const buf = new Float32Array(1024);
    this.tick = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms > 0) this.frames++;
      const ev = this.vad.feed(rms, Date.now());
      if (ev === "start") { micLog("event", "VAD: speech started"); this.cb.onSpeech?.(true); }
      if (ev === "end") {
        const u = { start: this.vad.start, end: Date.now() };
        micLog("event", `VAD: speech ended (${u.end - u.start} ms)`);
        this.cb.onSpeech?.(false);
        this.cb.onUtterance?.({ ...u, clip: this.clip(u.start) });
      }
    }, 50);
    this.beat = setInterval(() => this.heartbeat(), 5000);
    // start-up self-test (owner: "mic start"): within 3 s the stream must deliver audio frames, else rebuild once
    const startFrames = this.frames;
    setTimeout(() => { if (this.running && this.analyser && this.frames === startFrames) { micLog("error", "start failed: the microphone stream delivers no audio frames"); void this.rebuild("no audio after start"); } }, 3000);
    navigator.mediaDevices?.addEventListener?.("devicechange", this.onDevice);
    document.addEventListener("visibilitychange", this.onVis);
    void this.lockScreen();
    micLog("event", `mic guard: on (${this.stream.getAudioTracks()[0]?.label || "microphone"})`);
    return true;
  }

  /** The utterance from 1 s before it started: the header slice + the slices since. */
  private clip(start: number): Blob | null {
    if (!this.header) return null;
    const parts = this.chunks.filter((c) => c.t >= start - 1000).map((c) => c.b);
    return parts.length ? new Blob([this.header, ...parts], { type: this.header.type || "audio/webm" }) : null;
  }

  private heartbeat() {
    const tr = this.stream?.getAudioTracks()[0];
    const frames = this.frames - this.lastFrames;
    this.lastFrames = this.frames;
    if (this.ctx?.state === "suspended") void this.ctx.resume();
    const bad = !tr ? "no track" : tr.readyState !== "live" ? "track ended" : tr.muted ? "track muted" : this.analyser && frames === 0 ? "no audio frames" : null;
    if (bad) void this.rebuild(bad);
  }

  async rebuild(why: string) {
    if (!this.running) return;
    micLog("event", `mic guard: rebuild (${why})`);
    this.release();
    this.running = false;
    await this.start();
  }

  private async lockScreen() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !document.hidden) { this.wakeLock = await wl.request("screen"); micLog("event", "screen wake lock held"); }
    } catch { /* not allowed here: fine */ }
  }

  private release() {
    this.cb.onRelease?.();
    if (this.tick) clearInterval(this.tick);
    if (this.beat) clearInterval(this.beat);
    this.tick = null; this.beat = null;
    try { if (this.rec && this.rec.state !== "inactive") this.rec.stop(); } catch { /* ignore */ }
    this.rec = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.stream) micLog("event", "mic stream released (mic guard)");
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null; this.analyser = null;
    navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDevice);
    document.removeEventListener("visibilitychange", this.onVis);
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.vad = new VadState();
  }

  stop() { if (!this.running && !this.stream) return; this.running = false; this.release(); }
}
