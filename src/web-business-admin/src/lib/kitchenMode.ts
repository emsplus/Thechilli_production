import { useSyncExternalStore } from "react";
import type { RoleState } from "./useRole";

/**
 * How /kitchen is shown (docs/UX_WALKTHROUGH.md, "Kitchen: implemented answer"):
 * - kitchen-role users always get the full-screen kiosk (large text, tap a ticket to advance, no navigation);
 * - owner / manager / cashier / waiter open it INSIDE the normal shell (sidebar and top bar, easy way back), and may switch
 *   to full screen with the "Full screen" button (remembered on this device) and back with "Exit full screen".
 * While the role is still loading the kiosk is assumed (the kitchen tablet must never flash the back-office navigation).
 */
export type KitchenMode = "kiosk" | "shell";

export function kitchenMode(role: RoleState | undefined, fullScreenPref: boolean): KitchenMode {
  if (role === "kitchen" || role === null || role === undefined) return "kiosk";
  return fullScreenPref ? "kiosk" : "shell";
}

/** Only the kitchen role is locked into the kiosk; everyone else can leave it. */
export const canLeaveKiosk = (role: RoleState | undefined) => !!role && role !== "kitchen";

const KEY = "pos.kds.fullscreen";
const EVT = "pos-kds-fullscreen";
const read = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const subscribe = (cb: () => void) => {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
};

export function setKitchenFullScreen(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage unavailable: the choice lasts this page only */ }
  window.dispatchEvent(new Event(EVT));
}

/** This device's "Full screen" choice for non-kitchen roles. */
export function useKitchenFullScreen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
