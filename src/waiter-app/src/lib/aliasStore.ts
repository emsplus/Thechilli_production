"use client";
import { useEffect, useState } from "react";
import { api, auth } from "./api";
import type { Alias } from "./aliases";

/** Learnt voice phrases for search. Network refresh, per-restaurant localStorage cache for offline; failures just mean no extra aliases. */
const key = () => `waiter.aliases.${auth.restaurantId ?? "x"}`;
export function readCachedAliases(): Alias[] {
  try { const v = JSON.parse(localStorage.getItem(key()) ?? "[]") as unknown; return Array.isArray(v) ? (v as Alias[]) : []; } catch { return []; }
}
export function useAliases(): Alias[] {
  const [aliases, setAliases] = useState<Alias[]>([]);
  useEffect(() => {
    let live = true;
    const cached = readCachedAliases();
    if (cached.length) queueMicrotask(() => { if (live) setAliases(cached); });
    api.voiceAliases().then((a) => {
      if (!live) return;
      const slim = a.map(({ phrase, menu_item_id, variant_id, item_active }) => ({ phrase, menu_item_id, variant_id, item_active }));
      setAliases(slim);
      try { localStorage.setItem(key(), JSON.stringify(slim)); } catch { /* ignore */ }
    }).catch(() => { /* offline or no permission: keep cache */ });
    return () => { live = false; };
  }, []);
  return aliases;
}
