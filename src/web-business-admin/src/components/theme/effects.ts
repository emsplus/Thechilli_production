"use client";

import { useCallback, useSyncExternalStore } from "react";
import { EFFECTS_KEY } from "./init-scripts";

/** What the user picked. "auto" (default) = full unless the device looks low-end or prefers reduced motion. */
export type EffectsSetting = "auto" | "full" | "reduced";
/** What is in force right now. */
export type EffectsLevel = "full" | "reduced";

const EVT = "pos-effects-change";
const RM = "(prefers-reduced-motion: reduce)";

function readSetting(): EffectsSetting {
  try {
    const v = localStorage.getItem(EFFECTS_KEY);
    return v === "full" || v === "reduced" ? v : "auto";
  } catch { return "auto"; }
}

/** Heuristic used when the setting is "auto". Mirrors EFFECTS_INIT_SCRIPT. */
export function autoReduce(): boolean {
  const n = navigator as Navigator & { deviceMemory?: number };
  return (n.hardwareConcurrency || 8) <= 4 || (n.deviceMemory || 8) <= 4 || window.matchMedia(RM).matches;
}

function resolve(setting: EffectsSetting): EffectsLevel {
  if (setting === "full") return "full";
  if (setting === "reduced") return "reduced";
  return autoReduce() ? "reduced" : "full";
}

function apply(level: EffectsLevel) {
  if (level === "reduced") document.documentElement.setAttribute("data-effects", "reduced");
  else document.documentElement.removeAttribute("data-effects");
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia(RM);
  const onMq = () => { apply(resolve(readSetting())); cb(); };
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", onMq);
  mq.addEventListener("change", onMq);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", onMq); mq.removeEventListener("change", onMq); };
}

const levelSnapshot = (): EffectsLevel => (document.documentElement.getAttribute("data-effects") === "reduced" ? "reduced" : "full");

/**
 * Visual effects level. `level` is null during SSR/hydration: treat null as "reduced" (render the cheap fallback first).
 * Setting persists in localStorage["pos.effects"]; the pre-paint script applies it as html[data-effects=reduced].
 *   const { level, setting, setSetting } = useEffectsLevel();
 *   const rich = level === "full";
 */
export function useEffectsLevel() {
  const level = useSyncExternalStore<EffectsLevel | null>(subscribe, levelSnapshot, () => null);
  const setting = useSyncExternalStore<EffectsSetting>(subscribe, readSetting, () => "auto");
  const setSetting = useCallback((s: EffectsSetting) => {
    try { if (s === "auto") localStorage.removeItem(EFFECTS_KEY); else localStorage.setItem(EFFECTS_KEY, s); } catch { /* private mode: applies for this session */ }
    apply(resolve(s));
    window.dispatchEvent(new Event(EVT));
  }, []);
  return { level, setting, setSetting, rich: level === "full" };
}

/** Non-hook check for imperative code (event handlers, WAAPI animations). */
export function effectsAreFull(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-effects") !== "reduced" && !window.matchMedia(RM).matches;
}
