"use client";

import { useCallback, useSyncExternalStore } from "react";

/** The counter's "Veg only" filter: off by default, remembered on this device (a per-device convenience, not a setting). */
export const VEG_ONLY_KEY = "pos.vegOnly";
const listeners = new Set<() => void>();
let memory: boolean | null = null; // this tab's choice: still works when storage is blocked (private mode)

function read(): boolean {
  if (memory !== null) return memory;
  try { return window.localStorage.getItem(VEG_ONLY_KEY) === "1"; } catch { return false; }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === VEG_ONLY_KEY) { memory = null; cb(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useVegOnly(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((v: boolean) => {
    memory = v;
    try { if (v) window.localStorage.setItem(VEG_ONLY_KEY, "1"); else window.localStorage.removeItem(VEG_ONLY_KEY); } catch { /* private mode: not remembered */ }
    listeners.forEach((l) => l());
  }, []);
  return [on, set];
}
