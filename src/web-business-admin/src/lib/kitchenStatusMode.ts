import { useSyncExternalStore } from "react";
import { businessDate } from "./today";

/**
 * Kitchen status tracking (pos-service docs/KOT_ONLY_KITCHEN.md), one setting per restaurant:
 *   "kot_only"  default: the kitchen just receives the ticket and taps Done. No Preparing / Ready / Served anywhere.
 *   "track"     the full workflow (New -> Preparing -> Ready -> Served) with its chips and the waiter's ready alert.
 * The server stores it (PUT /restaurant `kitchen_status_mode`, owner only; GET /auth/me `order_rules.kitchen_status_mode` and
 * GET /restaurant return it) and `adoptServerKitchenMode` makes the server value win on every load. The device copy only serves
 * the first paint and offline starts; with no copy and no answer the default (KOT only) applies.
 */
export type KitchenStatusMode = "kot_only" | "track";
export const DEFAULT_KITCHEN_MODE: KitchenStatusMode = "kot_only";
const KEY = "pos.kitchen.statusMode";
const EVT = "pos-kitchen-status-mode";

export const parseKitchenMode = (v: unknown): KitchenStatusMode => (v === "track" ? "track" : "kot_only");

const read = (): KitchenStatusMode => { try { return parseKitchenMode(localStorage.getItem(KEY)); } catch { return DEFAULT_KITCHEN_MODE; } };
const subscribe = (cb: () => void) => {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener("storage", cb); };
};

export function getKitchenMode(): KitchenStatusMode { return typeof window === "undefined" ? DEFAULT_KITCHEN_MODE : read(); }

/** Saves the mode on this device (every open screen updates at once). */
export function setKitchenMode(mode: KitchenStatusMode) {
  try { localStorage.setItem(KEY, parseKitchenMode(mode)); } catch { /* storage unavailable: lasts this page only */ }
  window.dispatchEvent(new Event(EVT));
}

/** The server value (GET /restaurant `kitchen_status_mode` or /auth/me `order_rules.kitchen_status_mode`) replaces the device value. */
export function adoptServerKitchenMode(v: { kitchen_status_mode?: unknown; kitchen_display_minutes?: unknown } | null | undefined) {
  adoptServerDisplayMinutes(v);
  const m = v?.kitchen_status_mode;
  if (m !== "kot_only" && m !== "track") return;
  if (m !== getKitchenMode()) setKitchenMode(m);
  else { try { if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, m); } catch { /* ignore */ } }
}

/**
 * KOT-only kitchen screen: nobody is in the kitchen to click, so a ticket leaves the live list BY ITSELF this many minutes after it
 * arrived (and at end of day) and waits under "Earlier tickets". Setting "Show tickets for N minutes", 5..120, default 20
 * (PUT /restaurant `kitchen_display_minutes`, GET /auth/me `order_rules.kitchen_display_minutes`).
 */
export const DISPLAY_MIN = 5;
export const DISPLAY_MAX = 120;
export const DEFAULT_DISPLAY_MINUTES = 20;
const DKEY = "pos.kitchen.displayMin";
export function parseDisplayMinutes(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= DISPLAY_MIN && n <= DISPLAY_MAX ? n : DEFAULT_DISPLAY_MINUTES;
}
const readMin = () => { try { return parseDisplayMinutes(localStorage.getItem(DKEY)); } catch { return DEFAULT_DISPLAY_MINUTES; } };
export function getKitchenDisplayMinutes(): number { return typeof window === "undefined" ? DEFAULT_DISPLAY_MINUTES : readMin(); }
export function setKitchenDisplayMinutes(min: number) {
  try { localStorage.setItem(DKEY, String(parseDisplayMinutes(min))); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(EVT));
}
export function adoptServerDisplayMinutes(v: { kitchen_display_minutes?: unknown } | null | undefined) {
  const m = v?.kitchen_display_minutes;
  if (typeof m === "number" && parseDisplayMinutes(m) === m && m !== getKitchenDisplayMinutes()) setKitchenDisplayMinutes(m);
}
export function useKitchenDisplayMinutes(): number {
  return useSyncExternalStore(subscribe, readMin, () => DEFAULT_DISPLAY_MINUTES);
}

/** The kitchen mode of this restaurant, live. */
export function useKitchenMode(): KitchenStatusMode {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_KITCHEN_MODE);
}

/** Is a kitchen ticket still open on the kitchen screen? KOT only: until the kitchen taps Done (status served / done_at set) or it is cancelled. */
export function isOpenKot(k: { status: string; done_at?: string | null }): boolean {
  return k.status !== "cancelled" && k.status !== "served" && !k.done_at;
}

interface TicketLike { id: string; number: number; status: string; created_at?: string | null; done_at?: string | null }

/**
 * KOT-only kitchen screen, pure. `live` = tickets still shown: not cancelled, not dismissed (Dismiss / Done sets done_at), arrived less than
 * `minutes` ago and on today's business date; newest first. `earlier` = every other non-cancelled ticket, newest first (reachable, never deleted).
 * A ticket without an arrival time counts as arriving now (it stays live).
 */
export function splitTickets<T extends TicketLike>(kots: T[], now: number, minutes: number, timeZone?: string | null): { live: T[]; earlier: T[] } {
  const today = businessDate(new Date(now), timeZone);
  const live: T[] = [], earlier: T[] = [];
  for (const k of [...kots].sort((a, b) => b.number - a.number)) {
    if (k.status === "cancelled") continue;
    const at = k.created_at ? Date.parse(k.created_at) : NaN;
    const fresh = !Number.isFinite(at) || (now - at < minutes * 60_000 && businessDate(new Date(at), timeZone) === today);
    (k.status !== "served" && !k.done_at && fresh ? live : earlier).push(k);
  }
  return { live, earlier };
}
