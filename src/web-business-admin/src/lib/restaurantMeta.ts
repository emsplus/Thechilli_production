"use client";

import { useEffect, useState } from "react";
import { adoptServerTarget } from "./kitchenTarget";
import { api } from "@/lib/api";
import { timezoneLabel } from "./timezoneLabel";

/** What the shell shows about the restaurant: name + a one-line "India (IST) · CUR" subtitle, cached for offline starts. */
export interface RestaurantMeta { name: string; subtitle: string }

export const FALLBACK_NAME = "Chilli";
const NAME_KEY = "pos.restaurantName"; // shared with the provisional receipt (pos/_components/OrderPanel)
const SUB_KEY = "pos.restaurantSubtitle";

/** "India (IST) · INR": the time zone name (backend `timezone_label`, else mapped from the zone), not the zone's city. */
export function subtitleFor(currency?: string | null, timezone?: string | null, label?: string | null): string {
  return [timezoneLabel(timezone, label), currency?.toUpperCase()].filter(Boolean).join(" · ");
}

function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* storage unavailable */ } }

let inflight: Promise<RestaurantMeta | null> | null = null;
function load(): Promise<RestaurantMeta | null> {
  inflight ??= api.restaurant()
    .then((r) => {
      const m = { name: r.name || FALLBACK_NAME, subtitle: subtitleFor(r.currency, r.timezone, r.timezone_label) };
      write(NAME_KEY, m.name); write(SUB_KEY, m.subtitle);
      adoptServerTarget(r as { kitchen_target_minutes?: number | null }); // once pos-service stores the kitchen target
      return m;
    })
    .catch(() => null)
    .finally(() => { setTimeout(() => { inflight = null; }, 30_000); });
  return inflight;
}

const EVT = "pos-restaurant-meta";
/** Re-reads name / city / currency (after the owner edits the profile or switches country). */
export function refreshRestaurantMeta() {
  inflight = null;
  void load().then(() => window.dispatchEvent(new Event(EVT)));
}

/** Renders "Chilli" first (SSR-safe), swaps in the cached name, then the fresh one from /restaurant. */
export function useRestaurantMeta(): RestaurantMeta {
  const [meta, setMeta] = useState<RestaurantMeta>({ name: FALLBACK_NAME, subtitle: "" });
  useEffect(() => {
    let off = false;
    const name = read(NAME_KEY);
    if (name) void Promise.resolve().then(() => { if (!off) setMeta({ name, subtitle: read(SUB_KEY) ?? "" }); });
    void load().then((m) => { if (m && !off) setMeta(m); });
    const again = () => { void load().then((m) => { if (m && !off) setMeta(m); }); };
    window.addEventListener(EVT, again);
    return () => { off = true; window.removeEventListener(EVT, again); };
  }, []);
  return meta;
}
