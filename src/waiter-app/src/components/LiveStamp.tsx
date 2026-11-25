"use client";
import { useEffect, useState } from "react";
import { refreshLive, updatedText, useLive } from "@/lib/liveSync";
import { useMenu } from "@/lib/menu";

/** Refresh everything the floor screens show: open orders, table status, and the menu (prices, sold out, tables). */
export function useRefreshAll() {
  const { refresh } = useMenu();
  return () => Promise.all([refreshLive(), refresh().catch(() => {})]);
}

/** Small "Updated just now · Refresh" line: the server is the source of truth, this says how fresh the screen is. */
export function LiveStamp() {
  const s = useLive();
  const refreshAll = useRefreshAll();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  return (
    <div className="livestamp small muted">
      <span role="status" data-testid="live-stamp">{s.refreshing && !s.at ? "Updating..." : updatedText(s.at, s.live, Math.max(now, s.at ? Date.parse(s.at) : 0))}</span>
      <button type="button" className="linkbtn" onClick={() => void refreshAll()} disabled={s.refreshing} aria-label="Refresh orders and tables now">
        {s.refreshing ? "Refreshing..." : "Refresh"}
      </button>
    </div>
  );
}
