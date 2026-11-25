"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import { useLive } from "./liveSync";
import type { ServerOrder } from "./types";

const POLL = Number(process.env.NEXT_PUBLIC_READY_POLL_MS ?? 8000);

const LIVE_KEY = "open,sent_to_kitchen";
/** Open orders come from the shared live poller (lib/liveSync.ts); other statuses (history) poll here. */
export function useServerOrders(statusKey: string) {
  const live = useLive();
  const other = useOtherOrders(statusKey === LIVE_KEY ? null : statusKey);
  return statusKey === LIVE_KEY ? { orders: live.orders, err: live.live ? null : live.err } : other;
}

/** Polls GET /orders for the given statuses (comma-joined key keeps the dependency a simple expression) while the page is visible. */
function useOtherOrders(statusKey: string | null) {
  const [orders, setOrders] = useState<ServerOrder[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!statusKey) return;
    let live = true;
    const load = () => Promise.all(statusKey.split(",").map((s) => api.orders(s)))
      .then((r) => { if (live) { setOrders(r.flat()); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "Cannot load"); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL);
    return () => { live = false; clearInterval(t); };
  }, [statusKey]);
  return { orders, err };
}
