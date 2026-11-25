import { useSyncExternalStore } from "react";
import { KITCHEN_TARGET_MIN } from "./ticketAge";

/**
 * The kitchen's ticket target in minutes ("getting late" from the target, "late" from twice the target; see ticketAge.ts).
 * Set in Manage > Restaurant > Kitchen: pos-service stores it per restaurant (PUT /restaurant `kitchen_target_minutes`, owner only),
 * and `adoptServerTarget` makes the server value win on every load. The device copy is what offline starts and the kitchen
 * screen read before the first answer arrives.
 */
export const TARGET_MIN = 5;
export const TARGET_MAX = 90;
const KEY = "pos.kitchen.targetMin";
const EVT = "pos-kitchen-target";

/** A usable target: whole minutes within [TARGET_MIN, TARGET_MAX]; anything else falls back to the default (15). */
export function parseTarget(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= TARGET_MIN && n <= TARGET_MAX ? n : KITCHEN_TARGET_MIN;
}

const read = () => { try { return parseTarget(localStorage.getItem(KEY)); } catch { return KITCHEN_TARGET_MIN; } };
const subscribe = (cb: () => void) => {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
};

export function getKitchenTarget(): number { return typeof window === "undefined" ? KITCHEN_TARGET_MIN : read(); }

/** Saves the target on this device (every open screen updates at once). */
export function setKitchenTarget(min: number) {
  const v = parseTarget(min);
  try { localStorage.setItem(KEY, String(v)); } catch { /* storage unavailable: lasts this page only */ }
  window.dispatchEvent(new Event(EVT));
}

/** When the server stores the setting (future `kitchen_target_minutes` on GET /restaurant), it replaces the device value. */
export function adoptServerTarget(r: { kitchen_target_minutes?: number | null } | null | undefined) {
  if (r && typeof r.kitchen_target_minutes === "number" && parseTarget(r.kitchen_target_minutes) === r.kitchen_target_minutes && r.kitchen_target_minutes !== getKitchenTarget()) setKitchenTarget(r.kitchen_target_minutes);
}

/** The kitchen target for this device, live. */
export function useKitchenTarget(): number {
  return useSyncExternalStore(subscribe, read, () => KITCHEN_TARGET_MIN);
}
