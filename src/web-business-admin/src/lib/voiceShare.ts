/**
 * TESTING PHASE ONLY (owner, 2026-11-02; removed before real customers): "share what the mic heard", TEXT ONLY (never audio),
 * switched on and off in ONE place by the server (pos-service):
 *   GET  /api/v1/voice/wake-config  -> { share_samples: boolean, variants: string[] }   (at app start and every 6 h)
 *   POST /api/v1/voice/wake-samples { samples: [{ heard <= 120, matched, kind: "wake" | "command", device <= 64 }] } (<= 50, 204)
 *   403 / 404 = the feature is off: stop silently for this page.
 * share_samples false (the production default): no sample request at all and no notice. True: Voice settings shows a one-line
 * notice with a switch (default on, remembered per device). Samples are only the words around the wake phrase and the phrase
 * before a voice command, cut to 120 characters, with every digit removed (no phone numbers); at most one call a minute, never
 * blocking, no retries (a failed batch is dropped). Server `variants` go through the SAME guard rails as on-device learning
 * (wakeWord.ts setServerForms) and never replace the built-in matcher. Unit-tested in voiceShare.test.ts.
 */
import { setServerForms } from "./wakeWord";

export interface WakeSample { heard: string; matched: boolean; kind: "wake" | "command"; device: string }
interface Transport {
  get: () => Promise<{ share_samples?: unknown; variants?: unknown }>;
  post: (body: { samples: WakeSample[] }) => Promise<void>;
}
type Err = { status?: number };

export const SHARE_MAX_BATCH = 50;
export const SHARE_MIN_GAP_MS = 60_000;
export const SHARE_CONFIG_EVERY_MS = 6 * 3_600_000;
const SWITCH_KEY = "pos.voiceShare";
const DEVICE_KEY = "pos.voiceShareDevice";

let transport: Transport | null = null;
let serverOn = false;   // what the server said (false until it says otherwise)
let stopped = false;    // a 403 / 404 this page: off until a reload
let queue: WakeSample[] = [];
let lastPost = -Infinity;
let timer: ReturnType<typeof setTimeout> | null = null;
let clock = () => Date.now();
const listeners = new Set<() => void>();

/** Wiring (the till passes its API client; tests a mock). */
export function setShareTransport(t: Transport | null, now?: () => number) { transport = t; if (now) clock = now; }
export const onShareChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const changed = () => listeners.forEach((f) => f());

/** The server allows sharing (and this page did not get a 403 / 404): the notice and the switch are shown. */
export const shareOffered = () => serverOn && !stopped;
/** The person's switch on this device (default on while the server offers it). */
export function shareSwitch(): boolean { try { return localStorage.getItem(SWITCH_KEY) !== "0"; } catch { return true; } }
export function setShareSwitch(on: boolean) { try { localStorage.setItem(SWITCH_KEY, on ? "1" : "0"); } catch { /* private mode */ } if (!on) queue = []; changed(); }
export const sharing = () => shareOffered() && shareSwitch();

function deviceId(): string {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) { d = `dev-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(DEVICE_KEY, d); }
    return d.slice(0, 64);
  } catch { return "dev-private"; }
}

/** Only text, no digits (phone numbers, bill numbers), at most 120 characters. */
export const cleanHeard = (t: string) => t.replace(/\p{Nd}+/gu, "").replace(/\s{2,}/g, " ").replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "").slice(0, 120);

/**
 * Asks the server at most once per browser session and every 6 h (sessionStorage cache: a reload or a re-mount never asks
 * again; a 403 / 404 is remembered for the session). Any failure = off.
 */
const CACHE_KEY = "pos.wakeConfig";
export async function refreshWakeConfig(force = false): Promise<void> {
  if (!transport || stopped) return;
  if (!force) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      const c = raw ? JSON.parse(raw) as { at: number; off?: boolean; share?: boolean; variants?: string[] } : null;
      if (c && clock() - c.at < SHARE_CONFIG_EVERY_MS) {
        if (c.off) stopped = true;
        serverOn = !c.off && c.share === true;
        setServerForms(c.variants ?? []);
        changed();
        return;
      }
    } catch { /* no cache */ }
  }
  let entry: { at: number; off?: boolean; share?: boolean; variants?: string[] } = { at: clock() };
  try {
    const c = await transport.get();
    serverOn = c.share_samples === true;
    const variants = Array.isArray(c.variants) ? c.variants.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
    setServerForms(variants);
    entry = { ...entry, share: serverOn, variants };
  } catch (e) {
    serverOn = false;
    if ([403, 404].includes((e as Err)?.status ?? 0)) { stopped = true; entry = { ...entry, off: true }; }
  }
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry)); } catch { /* private mode */ }
  if (!sharing()) queue = [];
  changed();
}

/** One sample (the words around the wake phrase, or the phrase before a command). Ignored unless sharing is on. */
export function shareSample(heard: string, matched: boolean, kind: "wake" | "command", lang = "en-IN") {
  if (!sharing()) return;
  const h = cleanHeard(heard);
  if (!h) return;
  // the recogniser language rides in the device field (the contract has no lang field): "dev-ab12cd34|en-IN"
  queue = [...queue, { heard: h, matched, kind, device: `${deviceId()}|${lang}`.slice(0, 64) }].slice(-SHARE_MAX_BATCH);
  schedule();
}

function schedule() {
  if (timer || !queue.length) return;
  const wait = Math.max(0, lastPost + SHARE_MIN_GAP_MS - clock());
  timer = setTimeout(() => { timer = null; void flush(); }, wait);
}

/** Sends the batch (at most one call a minute); a failed batch is dropped, a 403 / 404 stops sharing for this page. */
export async function flush(): Promise<void> {
  if (!transport || !sharing() || !queue.length) { queue = sharing() ? queue : []; return; }
  if (clock() - lastPost < SHARE_MIN_GAP_MS) { schedule(); return; }
  const batch = queue.slice(0, SHARE_MAX_BATCH);
  queue = queue.slice(batch.length);
  lastPost = clock();
  try { await transport.post({ samples: batch }); }
  catch (e) { if ([403, 404].includes((e as Err)?.status ?? 0)) { stopped = true; queue = []; changed(); } }
  if (queue.length) schedule();
}

/** Test hook. */
export function resetShare() { try { sessionStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } serverOn = false; stopped = false; queue = []; lastPost = -Infinity; if (timer) clearTimeout(timer); timer = null; setServerForms([]); }
export const pendingSamples = () => [...queue];
/** Test hook: a new page (memory gone, the session cache kept). */
export function resetShareMemoryOnly() { serverOn = false; stopped = false; queue = []; }
