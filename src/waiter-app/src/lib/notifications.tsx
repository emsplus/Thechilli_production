"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, auth } from "./api";
import { myKotKeys, newlyReady, onlyMine, type ReadyFeed } from "./ready";
import { useQueue } from "./sync";
import { getKitchenMode } from "./capsStore";
import { getSessionStart } from "./sessionStart";
import { useLive } from "./liveSync";
import type { Kot } from "./types";

const POLL_MS = Number(process.env.NEXT_PUBLIC_READY_POLL_MS ?? 8000);
const SEEN_KEY = "waiter.readySeen";

interface Ctx { ready: Kot[]; dismiss: (id: string) => void }
const C = createContext<Ctx>({ ready: [], dismiss: () => {} });
export const useReady = () => useContext(C);

/** Polling transport. TODO(realtime): replace with a WebSocket feed implementing ReadyFeed once pos-service exposes one. */
function pollingFeed(): ReadyFeed {
  let t: ReturnType<typeof setTimeout> | null = null;
  let on = false;
  return {
    start(onReady) {
      on = true;
      const loop = async () => {
        if (!on) return;
        // KOT-only kitchen (default): nothing ever becomes "ready", so there is nothing to poll or announce.
        if (auth.token && document.visibilityState === "visible" && navigator.onLine && getKitchenMode() === "track") {
          try { onReady(await api.kots("ready")); } catch { /* transient; next tick */ }
        }
        t = setTimeout(loop, POLL_MS);
      };
      void loop();
    },
    stop() { on = false; if (t) clearTimeout(t); },
  };
}

export function ReadyProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState<Kot[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const ops = useQueue();
  // Latest "my KOTs" for the polling callback, which outlives renders.
  const mine = useRef<Set<string>>(new Set());
  useEffect(() => { mine.current = myKotKeys(ops, getSessionStart(), auth.restaurantId); }, [ops]);
  const live = useLive();
  const myOrders = useRef<Set<string>>(new Set());
  useEffect(() => { const me = auth.userId; myOrders.current = new Set(me ? live.active.filter((o) => o.waiter_id === me).map((o) => o.id) : []); }, [live.active]);
  useEffect(() => {
    try { seen.current = new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]")); } catch { /* ignore */ }
    const feed = pollingFeed();
    feed.start((kots) => {
      const fresh = newlyReady(onlyMine(kots, mine.current, myOrders.current), seen.current);
      if (!fresh.length) return;
      fresh.forEach((k) => seen.current.add(k.id));
      try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-200))); } catch { /* ignore */ }
      setReady((r) => [...r, ...fresh]);
      try { navigator.vibrate?.([200, 100, 200]); } catch { /* unsupported */ }
    });
    return () => feed.stop();
  }, []);
  const dismiss = useCallback((id: string) => setReady((r) => r.filter((k) => k.id !== id)), []);
  return <C.Provider value={{ ready, dismiss }}>{children}</C.Provider>;
}
