/**
 * When hands-free ("Hey Zonov") may start listening again by itself after it stopped. Pure (unit-tested in handsFree.test.ts).
 *
 * Why it stopped (`Sleep`):
 *  - "sleeping": the speech service failed again and again and the listener gave up calmly (liveSpeech onFail "sleeping");
 *  - "blocked":  the microphone permission is denied (or there is no microphone);
 *  - "tap":      this browser only starts listening inside a tap (iOS-like), or ignored the permission prompt.
 * What may wake it (`Trigger`): the window gets focus, the tab becomes visible, the device comes back online, the
 * microphone permission changes to granted, a new order, a tap on the mic or the hands-free switch.
 *
 * Rules: a tap or the switch always re-arms. A denied permission is NEVER retried by itself (only a permission change to
 * granted re-arms it), so a denied microphone can never loop. A browser that needs a tap only re-arms on a new order or a
 * granted permission. A sleeping listener re-arms on focus / visible / online / new order / granted, at most
 * REARM_LIMIT.max times in REARM_LIMIT.windowMs; after that it waits for a tap (a broken speech service cannot spin).
 */
export type Sleep = "sleeping" | "blocked" | "nomic" | "tap" | null;
/**
 * "timer": the till's own retry while "sleeping" (15 s, 30 s, 1, 2, 5 min, then every 5 min: UNLIMITED; owner bug 2026-11-02, a
 * counter screen that stays focused and visible never got a focus / visible trigger, so hands-free stayed dead until a reload);
 * "device": a microphone was plugged in or out (also wakes "nomic"); "reset": the "Mic not working? Reset" button.
 */
export type Trigger = "focus" | "visible" | "online" | "permission-granted" | "new-ticket" | "tap" | "switch-on" | "timer" | "device" | "reset";
/** The till's own retry delays while sleeping (ms); the last one repeats for ever. */
export const SLEEP_RETRY_MS = [1_000, 3_000]; // never sleep (owner, 2026-11-02): 1 s, then every 3 s, forever
export const sleepRetryDelay = (n: number) => SLEEP_RETRY_MS[Math.min(n, SLEEP_RETRY_MS.length - 1)];

export const REARM_LIMIT = { max: 4, windowMs: 10 * 60_000 };

export interface RearmState { sleep: Sleep; /** times (ms) of earlier automatic re-arms */ history: number[] }

export function rearmDecision(s: RearmState, trigger: Trigger, now: number, off: boolean): { rearm: boolean; state: RearmState } {
  if (off) return { rearm: false, state: s };
  if (trigger === "tap" || trigger === "switch-on" || trigger === "reset") return { rearm: true, state: { sleep: null, history: [] } };
  if (s.sleep === null) return { rearm: false, state: s };
  if (s.sleep === "nomic") return trigger === "device" || trigger === "permission-granted" || trigger === "focus" ? { rearm: true, state: { sleep: null, history: s.history } } : { rearm: false, state: s };
  if (s.sleep === "blocked") return trigger === "permission-granted" ? { rearm: true, state: { sleep: null, history: [] } } : { rearm: false, state: s };
  if (s.sleep === "tap") return trigger === "permission-granted" || trigger === "new-ticket" ? { rearm: true, state: { sleep: null, history: s.history } } : { rearm: false, state: s };
  // sleeping: the till's own timer and a microphone change always retry (the timer backs off by itself); the event triggers are limited
  if (trigger === "timer" || trigger === "device") return { rearm: true, state: { sleep: null, history: s.history } };
  const recent = s.history.filter((t) => now - t < REARM_LIMIT.windowMs);
  if (recent.length >= REARM_LIMIT.max) return { rearm: false, state: { sleep: "sleeping", history: recent } };
  return { rearm: true, state: { sleep: null, history: [...recent, now] } };
}

/** The visible words for the hands-free switch and the mic tooltip. */
export function handsFreeLabel(o: { on: boolean; listening: boolean; trouble: string | null; sleep: Sleep; wait: string | null; alive?: boolean }): { state: "off" | "listening" | "paused"; short: string; long: string } {
  if (!o.on) return { state: "off", short: "Off", long: "Hands-free is off. Turn it on to start orders by saying “Hey Zonov”." };
  // "Listening" only after Chrome really started (onstart / audiostart), never from our own state alone (owner: "mic start")
  if (o.listening && o.alive === false && !o.trouble) return { state: "listening", short: "Starting…", long: "Starting the microphone…" };
  if (o.listening) return { state: "listening", short: o.trouble ? "Reconnecting" : "Listening", long: o.trouble ? `Waiting for “Hey Zonov”, but the speech service keeps failing (${o.trouble}). Trying again…` : "Waiting for “Hey Zonov”" };
  if (o.sleep === "sleeping") return { state: "paused", short: "Reconnecting", long: "Hands-free is reconnecting: the speech service kept failing. It tries again by itself; “Mic not working? Reset” in Voice settings starts it now." };
  if (o.sleep === "blocked") return { state: "paused", short: "Mic blocked", long: "Microphone not available. Allow it in the browser's site settings (the lock icon next to the address), then tap the mic." };
  if (o.sleep === "nomic") return { state: "paused", short: "No mic", long: "No microphone found. Plug one in or choose it in the system settings; hands-free starts again by itself." };
  if (o.sleep === "tap") return { state: "paused", short: "Paused", long: "Tap the mic to start listening (this browser needs a tap first)" };
  return { state: "paused", short: "Paused", long: o.wait ?? "Hands-free is starting…" };
}
