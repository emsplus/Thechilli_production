"use client";

import { useCallback, useEffect, useState } from "react";
import { lastReachable, onSyncChange } from "./sync";
import { listOps, type QueuedOp } from "./offlineDb";

export function useSyncStatus() {
  const [ops, setOps] = useState<QueuedOp[]>([]);
  const [online, setOnline] = useState(true);
  const refresh = useCallback(async () => {
    try { setOps(await listOps()); } catch { setOps([]); }
    setOnline(navigator.onLine && lastReachable);
  }, []);

  useEffect(() => {
    const go = () => void refresh();
    void Promise.resolve().then(go);
    const off = onSyncChange(go);
    window.addEventListener("online", go);
    window.addEventListener("offline", go);
    return () => { off(); window.removeEventListener("online", go); window.removeEventListener("offline", go); };
  }, [refresh]);

  const count = (s: QueuedOp["status"]) => ops.filter((o) => o.status === s).length;
  return { ops, online, pending: count("pending"), syncing: count("syncing"), failed: count("failed"), conflict: count("conflict"), synced: count("synced") };
}
