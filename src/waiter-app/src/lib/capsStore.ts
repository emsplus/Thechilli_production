"use client";
import { useSyncExternalStore } from "react";
import { auth, ME_EVENT, ME_KEY } from "./api";
import { allowedModes, defaultMode, homeRoute, kitchenModeFromMe, profileFromMe, RESTAURANT_PROFILE, type BusinessProfile, type KitchenStatusMode, type ServiceMode } from "./capabilities";

/**
 * The business profile of the signed-in restaurant, read from the last /auth/me answer that the device kept (api.me() stores it
 * on every call), so the app opens the right screens offline too. The copy is only trusted for the restaurant it came from (its
 * `rid` against the token's): another restaurant signing in on the same device never inherits it. No copy = restaurant defaults.
 */
let lastRaw: string | null | undefined, lastRid: string | null | undefined, last: BusinessProfile = RESTAURANT_PROFILE;

export function getProfile(): BusinessProfile {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ME_KEY); } catch { /* storage blocked */ }
  const rid = auth.restaurantId;
  if (raw === lastRaw && rid === lastRid) return last;
  lastRaw = raw; lastRid = rid;
  let p = RESTAURANT_PROFILE;
  try {
    const me = raw ? (JSON.parse(raw) as { rid?: string | null }) : null;
    if (me && !(me.rid && rid && me.rid !== rid)) p = profileFromMe(me);
  } catch { /* corrupt copy: defaults */ }
  return (last = p);
}

const subscribe = (cb: () => void) => {
  window.addEventListener(ME_EVENT, cb); window.addEventListener("storage", cb);
  const off = auth.subscribe(cb); // the token (so the restaurant) changed
  return () => { window.removeEventListener(ME_EVENT, cb); window.removeEventListener("storage", cb); off(); };
};

/** Re-renders when /auth/me is refreshed or another restaurant signs in. Server render: restaurant defaults. */
export const useProfile = (): BusinessProfile => useSyncExternalStore(subscribe, getProfile, () => RESTAURANT_PROFILE);

export const allowedModesNow = (): ServiceMode[] => allowedModes(getProfile());
export const defaultModeNow = (): ServiceMode => defaultMode(getProfile());
export const homeRouteNow = () => homeRoute(getProfile());

/**
 * KOT only (default) or Track Preparing / Ready / Served, from the same kept /auth/me copy (only trusted for its own restaurant).
 * Anything unknown = "kot_only".
 */
export function getKitchenMode(): KitchenStatusMode {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ME_KEY); } catch { /* storage blocked */ }
  try {
    const me = raw ? (JSON.parse(raw) as { rid?: string | null }) : null;
    const rid = auth.restaurantId;
    return me && !(me.rid && rid && me.rid !== rid) ? kitchenModeFromMe(me) : "kot_only";
  } catch { return "kot_only"; }
}
export const useKitchenMode = (): KitchenStatusMode => useSyncExternalStore(subscribe, getKitchenMode, () => "kot_only");
