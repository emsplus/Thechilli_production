"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { api, auth } from "./api";
import { reviews } from "./tableQr";
import { useCan } from "./useRole";

/** Unread low guest ratings (1-2 stars from a table review QR) for owners / managers; 0 for anyone the server refuses (403). */
export function useLowReviews(): number {
  const pathname = usePathname();
  const [n, setN] = useState(0);
  // Only for people who may see reports: the summary needs reports.view, so a cashier / waiter / kitchen page load no longer fires a 403 (QA D27).
  const canSee = useCan().can("reports.view");
  useEffect(() => {
    if (!auth.token || !canSee) return;
    let off = false;
    const load = () => { reviews.summary().then((s) => { if (!off) setN(s.unread_low); }).catch(() => { /* no reports.view, offline or older server */ }); };
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener("chilli:reviews-read", load);
    return () => { off = true; clearInterval(t); window.removeEventListener("chilli:reviews-read", load); };
  }, [pathname, canSee]);
  return n;
}

/**
 * What the top bar bell counts (null until known): open low-stock alerts plus unread low guest ratings. Refreshed on navigation
 * and every minute; failures keep the last value.
 */
export function useOpenAlerts(): number | null {
  const pathname = usePathname();
  const low = useLowReviews();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!auth.token) return;
    let off = false;
    const load = () => { api.alerts().then((a) => { if (!off) setN(a.filter((x) => x.status === "open").length); }).catch(() => { /* offline or signed out */ }); };
    load();
    const t = setInterval(load, 60_000);
    return () => { off = true; clearInterval(t); };
  }, [pathname]);
  return n === null ? (low ? low : null) : n + low;
}
