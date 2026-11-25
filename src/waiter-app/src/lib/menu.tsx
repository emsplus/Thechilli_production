"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { setCurrencySymbol } from "./money";
import { setModifierGroups } from "./modifiers";
import { OUTLET_EVENT } from "./outletEvent";
import { loadMenu, staleness, type Snapshot } from "./menuCache";
import { monoNow } from "./clock";

const MENU_POLL_MS = Number(process.env.NEXT_PUBLIC_MENU_POLL_MS ?? 30_000);
/** Same name as liveSync.RESUME_EVENT (not imported: liveSync pulls in the API client and queue, menu.tsx stays light). */
const RESUME_EVENT = "waiter-resume";

interface Ctx { snap: Snapshot | null; loading: boolean; fromCache: boolean; stale: boolean; ageHours: number | null; refresh: () => Promise<void> }
const C = createContext<Ctx>({ snap: null, loading: true, fromCache: false, stale: false, ageHours: null, refresh: async () => {} });
export const useMenu = () => useContext(C);

export function MenuProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const refresh = useCallback(async () => {
    const r = await loadMenu();
    if (r) { setSnap(r.snap); setFromCache(r.fromCache); }
    setLoading(false);
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => { setLoading(true); setSnap(null); void loadMenu().then((r) => { if (!live) return; if (r) { setSnap(r.snap); setFromCache(r.fromCache); } setLoading(false); }); };
    load();
    window.addEventListener(OUTLET_EVENT, load); // outlet switched: tables and prices may differ
    // Keep the menu fresh while the app stays open (dish sold out / back, price, new table, made at the counter or on another
    // device): quietly every MENU_POLL_MS while visible, and at once when the app comes back. The old snapshot stays on screen
    // meanwhile, and an offline failure keeps it (the stale-menu banner covers that).
    let last = -Infinity; // monotonic: a clock set back must not stop the refresh for hours (lib/clock.ts)
    const revalidate = (minGap: number) => {
      if (document.visibilityState !== "visible" || monoNow() - last < minGap) return;
      last = monoNow();
      void loadMenu().then((r) => { if (live && r && !r.fromCache) { setSnap(r.snap); setFromCache(false); } });
    };
    const onVisible = () => revalidate(5000);
    const t = setInterval(() => revalidate(MENU_POLL_MS - 1000), MENU_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible); window.addEventListener("focus", onVisible); window.addEventListener(RESUME_EVENT, onVisible);
    return () => {
      live = false; clearInterval(t);
      window.removeEventListener(OUTLET_EVENT, load); document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible); window.removeEventListener("focus", onVisible); window.removeEventListener(RESUME_EVENT, onVisible);
    };
  }, []);
  setCurrencySymbol(snap?.currencySymbol); // module-level, idempotent; set before children render prices
  setModifierGroups(snap?.modifierGroups); // one-tap adds take the dish's default modifiers from here
  const { stale, ageHours } = staleness(snap?.savedAt);
  return <C.Provider value={{ snap, loading, fromCache, stale: !!snap && stale, ageHours, refresh }}>{children}</C.Provider>;
}
