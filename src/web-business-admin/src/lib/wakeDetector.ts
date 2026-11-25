/**
 * The OFFLINE wake detector (owner, 2026-11-02): Vosk (Kaldi, Apache-2.0) in WebAssembly, vosk-browser 0.0.8's worker (Apache-2.0), with
 * the small Indian-English model (vosk-model-small-en-in-0.4, Apache-2.0, ~36 MB) served from /voice-models/ (never in the JS
 * chunks), lazy-loaded the first time hands-free runs with the detector on, kept in the Cache API (no second download).
 * It listens continuously to the mic guard's stream (one AudioContext, no restarts, no cloud) with a RESTRICTED GRAMMAR: the
 * model's own words closest to "Hey Zonov" ("hey zone of", "hey joe nov", "hey john of", ...) and [unk] for everything else,
 * so it behaves as a keyword spotter. The cloud recogniser (Web Speech) and the server speech-to-text are used only AFTER the
 * wake, to capture the order. Measured on synthetic speech before choosing the grammar: docs/VOICE_QA_REPORT.md.
 * Pure parts (grammar, detection rule) are unit-tested in wakeDetector.test.ts.
 */
import { micLog } from "./micLog";
import type { WakeSensitivity } from "./wakeWord";

export const MODEL_URL = "/voice-models/vosk-model-small-en-in-0.4.tar.gz";
export const MODEL_MB = 36;
/**
 * Words of the model nearest to how "Hey Zonov" sounds (the model has no word "zonov"), plus DECOYS for what everyday talk
 * sounds like near it ("hey sonu" -> "hey so new", "the zone", "hey john"...): without them the decoder pushed that talk into
 * the target phrases (measured: 263 false accepts per hour on a background-talk set; with the decoys and the rule below: 5).
 * Anything else decodes as [unk].
 */
export const GRAMMAR = ["hey zone of", "hey joe nov", "hey john of", "zone of", "joe nov", "john of",
  "hey so new", "hey soon", "hey son", "hey sunny", "hey joe", "hey john", "zone", "the zone", "so new", "soon", "hey", "[unk]"];
const TARGET = /^(hey )(zone of|joe nov|john of)\b/;
const TARGET_NO_HEY = /^(hey )?(zone of|joe nov|john of)\b/;

const KEY = "pos.wakeDetector";
export const DETECTOR_DEFAULT = true;
export function detectorOn(): boolean { try { const v = localStorage.getItem(KEY); return v === null ? DETECTOR_DEFAULT : v === "1"; } catch { return DETECTOR_DEFAULT; } }
export function setDetectorOn(on: boolean) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* private mode */ } }

export interface Detection { text: string; conf: number | null; partial: boolean; words?: { word: string; conf: number }[] }
/** The thresholds per sensitivity (measured, docs/VOICE_QA_REPORT.md): the lowest confidence of the matched words. */
export const MIN_CONF: Record<WakeSensitivity, number> = { strict: 0.85, normal: 0.6, lenient: 0.7 };
/**
 * Does this detector output say "Hey Zonov"? A FINAL result that STARTS with the phrase (ignoring [unk]); "hey" needed in Strict
 * and Normal, not in Lenient; every matched word at least MIN_CONF confident. Partial results never wake (no confidence yet).
 */
export function isDetection(d: Detection, s: WakeSensitivity): boolean {
  if (d.partial) return false;
  const words = (d.words ?? d.text.split(/\s+/).map((w) => ({ word: w, conf: d.conf ?? 1 }))).filter((w) => w.word && w.word !== "[unk]");
  const t = words.map((w) => w.word.toLowerCase()).join(" ");
  const m = (s === "lenient" ? TARGET_NO_HEY : TARGET).exec(t);
  if (!m) return false;
  const n = m[0].split(" ").length;
  return Math.min(...words.slice(0, n).map((w) => w.conf)) >= MIN_CONF[s];
}

/** vosk-browser 0.0.8's worker, served from this origin (public/voice-models/; extracted from the package so no blob: worker and
 *  no 'unsafe-eval' are needed on the page). The protocol is the package's own (load / create / set / audioChunk / remove). */
export const WORKER_URL = "/voice-models/vosk-worker-0.0.8.js";
type Msg = { event?: string; recognizerId?: string; result?: unknown; error?: string };
class VoskClient {
  private handlers = new Map<string, (m: Msg) => void>();
  private constructor(private readonly worker: Worker) {
    worker.addEventListener("message", (e: MessageEvent<Msg>) => { const m = e.data; if (m?.recognizerId) this.handlers.get(m.recognizerId)?.(m); });
  }
  static load(modelUrl: string): Promise<VoskClient> {
    return new Promise((ok, fail) => {
      const w = new Worker(WORKER_URL);
      const timer = setTimeout(() => fail(new Error("model load timed out")), 180_000);
      w.addEventListener("error", (e) => { clearTimeout(timer); fail(new Error(`worker error: ${e.message || "load failed"}`)); });
      w.addEventListener("message", (e: MessageEvent<Msg>) => {
        if (e.data?.event === "load") { clearTimeout(timer); if (e.data.result) ok(new VoskClient(w)); else fail(new Error("model did not load")); }
        else if (e.data?.event === "error" && !e.data.recognizerId) { clearTimeout(timer); fail(new Error(e.data.error ?? "worker error")); }
      });
      w.postMessage({ action: "set", key: "logLevel", value: -1 });
      w.postMessage({ action: "load", modelUrl });
    });
  }
  recognizer(sampleRate: number, grammar: string[], on: (m: Msg) => void): Recognizer {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random()}`;
    this.handlers.set(id, on);
    this.worker.postMessage({ action: "create", recognizerId: id, sampleRate, grammar: JSON.stringify(grammar) });
    this.worker.postMessage({ action: "set", recognizerId: id, key: "words", value: true });
    return {
      accept: (buf: AudioBuffer) => {
        const data = buf.getChannelData(0).map((v) => v * 0x8000); // Kaldi wants int16 range
        this.worker.postMessage({ action: "audioChunk", data, recognizerId: id, sampleRate: buf.sampleRate }, [data.buffer]);
      },
      remove: () => { this.handlers.delete(id); this.worker.postMessage({ action: "remove", recognizerId: id }); },
    };
  }
  terminate() { this.worker.terminate(); }
}
interface Recognizer { accept(buf: AudioBuffer): void; remove(): void }

/** The model file through the Cache API (one download per device), with progress. */
async function modelBlobUrl(onProgress: (mb: number) => void): Promise<string> {
  const cacheName = "voice-models-v1";
  const url = new URL(MODEL_URL, window.location.origin).toString();
  let res: Response | undefined;
  try { res = await (await caches.open(cacheName)).match(url); } catch { /* no Cache API: plain fetch */ }
  if (!res) {
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`model download ${r.status}`);
    const total = Number(r.headers.get("Content-Length") ?? 0);
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      onProgress(Math.round((total || MODEL_MB * 1e6) / 1e6 - got / 1e6));
    }
    const blob = new Blob(parts as BlobPart[], { type: "application/gzip" });
    try { await (await caches.open(cacheName)).put(url, new Response(blob, { headers: { "Content-Type": "application/gzip" } })); } catch { /* storage full / private: fine */ }
    return URL.createObjectURL(blob);
  }
  return URL.createObjectURL(await res.blob());
}

export class WakeDetector {
  state: "off" | "loading" | "ready" | "failed" = "off";
  private model: VoskClient | null = null;
  private rec: Recognizer | null = null;
  private node: ScriptProcessorNode | null = null;
  private lastFire = 0;
  private cpuMs = 0;
  private audioS = 0;
  private stats: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly cb: { onWake: (d: Detection) => void; onState?: (s: WakeDetector["state"], note?: string) => void; sensitivity: () => WakeSensitivity }) {}

  private set(s: WakeDetector["state"], note?: string) { this.state = s; this.cb.onState?.(s, note); micLog(s === "failed" ? "error" : "event", `wake detector: ${s}${note ? ` (${note})` : ""}`); }

  /** Attaches to the mic guard's audio graph. Never throws: a failure leaves the Web Speech wake path as it is. */
  async start(ctx: AudioContext, source: MediaStreamAudioSourceNode) {
    if (this.state === "loading" || this.state === "ready") return;
    this.set("loading", `${MODEL_MB} MB model, once per device`);
    try {
      if (typeof WebAssembly === "undefined") throw new Error("no WebAssembly");
      if (!this.model) {
        const url = await modelBlobUrl((left) => this.cb.onState?.("loading", `${left} MB left`));
        this.model = await VoskClient.load(url);
      }
      const rec = this.model.recognizer(ctx.sampleRate, GRAMMAR, (m) => {
        const r = m.result as { text?: string; partial?: string; result?: { word: string; conf: number }[] } | undefined;
        if (m.event === "result") {
          const text = r?.text ?? "";
          if (!text.trim() || text.trim() === "[unk]") return;
          const words = (r?.result ?? []) as { word: string; conf: number }[];
          this.check({ text, conf: words.length ? words.reduce((a, w) => a + w.conf, 0) / words.length : null, partial: false, words });
        } else if (m.event === "partialresult") {
          const p = r?.partial ?? "";
          if (p.trim() && p.trim() !== "[unk]") this.check({ text: p, conf: null, partial: true });
        } else if (m.event === "error") micLog("error", `wake detector: ${m.error ?? "error"}`);
      });
      this.rec = rec;
      // ScriptProcessor: tiny main-thread cost (a copy per 4096 samples); the decoding runs in vosk-browser's worker
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        const t0 = performance.now();
        try { this.rec?.accept(e.inputBuffer); } catch { /* recognizer gone */ }
        this.cpuMs += performance.now() - t0; this.audioS += e.inputBuffer.duration;
      };
      source.connect(node);
      node.connect(ctx.destination); // silent output: required for onaudioprocess to run
      this.node = node;
      this.stats = setInterval(() => { if (this.audioS > 0) micLog("event", `wake detector: ${(this.cpuMs / this.audioS).toFixed(1)} ms main-thread per audio second`); this.cpuMs = 0; this.audioS = 0; }, 60_000);
      this.set("ready", `grammar: ${GRAMMAR.filter((g) => g !== "[unk]").join(" | ")}`);
    } catch (e) {
      this.set("failed", `${(e as Error)?.message || "error"}; the Web Speech wake path stays on`);
      this.detach();
    }
  }

  private check(d: Detection) {
    micLog(d.partial ? "interim" : "final", `detector ${d.partial ? "partial" : "result"}: “${d.text}”${d.conf !== null ? ` (confidence ${d.conf.toFixed(2)})` : ""}`);
    if (!isDetection(d, this.cb.sensitivity())) return;
    const now = Date.now();
    if (now - this.lastFire < 2500) return; // one wake per phrase (partials repeat)
    this.lastFire = now;
    micLog("wake", `WAKE by the offline detector: “${d.text}”${d.conf !== null ? ` confidence ${d.conf.toFixed(2)}` : " (partial)"}`);
    this.cb.onWake(d);
  }

  private detach() {
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.node = null;
    try { this.rec?.remove(); } catch { /* ignore */ }
    this.rec = null;
    if (this.stats) clearInterval(this.stats);
    this.stats = null;
  }

  /** The audio graph goes away (Reset, tab hidden): the model stays loaded for the next start. */
  stop() { this.detach(); if (this.state !== "failed") this.set("off"); }
}
