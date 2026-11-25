import type { PinSession } from "./core";

/**
 * Counter tablet state, shared by api.ts (which bearer token to send) and the counter screens. No imports of api.ts here
 * (api.ts imports this). The device credential lives in the platform secure store (iOS Keychain / Android Keystore via
 * lib/lock/native secureKv); the PIN session lives in memory only, so a restart always shows the roster again.
 */
export interface CounterStatus { ready: boolean; deviceToken: string | null; session: PinSession | null; ended: "idle" | "ended" | null }

let status: CounterStatus = { ready: false, deviceToken: null, session: null, ended: null };
const listeners = new Set<() => void>();

export const counterState = {
  get: () => status,
  set(p: Partial<CounterStatus>) { status = { ...status, ...p }; listeners.forEach((f) => f()); },
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  /** True on a tablet set up as a counter device (whether or not someone is signed in right now). */
  get active() { return !!status.deviceToken; },
};

export const COUNTER_TOKEN_KEY = "waiter.counter.token";
