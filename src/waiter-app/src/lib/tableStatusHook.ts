"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, auth, currentOutletId } from "./api";
import { computeTableStatus, type ActiveOrder, type TableInfo } from "./tableStatus";
import { useQueue } from "./sync";
import { getProfile } from "./capsStore";
import { refreshLive, useLive, type TableReservation } from "./liveSync";

const key = (k: string) => `waiter.${k}.${currentOutletId() ?? "default"}`;
export type { TableReservation };

/** Fresh list of open orders from the server (open + sent_to_kitchen, with whose each is), cached for offline. Throws when unreachable. */
export async function fetchActiveOrders(): Promise<ActiveOrder[]> {
  return (await refreshLive({ throwOnError: true })).active;
}

/** Server-backed table occupancy (shared live poller, lib/liveSync.ts). `live` is false when the last refresh failed: the map is then the last known one (offline). */
export function useTableStatus() {
  const ops = useQueue();
  const s = useLive();
  const refresh = useCallback(async () => { const r = await refreshLive(); return r.live ? r.active : null; }, []);
  const status: Record<string, TableInfo> = useMemo(() => computeTableStatus(s.active, ops, auth.userId), [s.active, ops]);
  return { status, reserved: s.reservations, unpaid: s.unpaid, at: s.at, live: s.live, refresh };
}

/** GET /tables/assigned. `ids === null` once we know the server has no assignment API; `undefined` while loading. */
export function useAssignedTables() {
  const [ids, setIds] = useState<Set<string> | null | undefined>(() => {
    try { const c = JSON.parse(localStorage.getItem(key("assigned")) ?? "undefined") as { ids: string[] | null } | undefined; return c ? (c.ids ? new Set(c.ids) : null) : undefined; } catch { return undefined; }
  });
  useEffect(() => {
    let live = true;
    const load = () => !getProfile().caps.tables ? Promise.resolve() : api.assignedTables().then((r) => { if (!live) return; setIds(r ? new Set(r) : null); try { localStorage.setItem(key("assigned"), JSON.stringify({ ids: r })); } catch { /* ignore */ } }).catch(() => { /* offline: keep the last answer */ });
    void load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return ids;
}
