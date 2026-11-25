"use client";

import { useEffect } from "react";
import { flush, recoverInterrupted } from "@/lib/sync";

/** Registers the service worker and drives foreground sync (mount, reconnect, focus, interval). */
export function SyncProvider() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      const sw = navigator.serviceWorker;
      const hadController = !!sw.controller;
      sw.register("/sw.js").then((reg) => {
        // Look for a new app version every time the installed app comes to the front (a phone keeps it alive for days).
        document.addEventListener("visibilitychange", () => { if (!document.hidden) void reg.update().catch(() => {}); });
      }).catch(() => { /* PWA install is optional */ });
      // A new version took over: reload onto it, but never in the middle of work: only while the app is in the background.
      let pending = false;
      const reloadNow = () => { if (document.hidden) location.reload(); };
      sw.addEventListener("controllerchange", () => { if (!hadController) return; pending = true; reloadNow(); });
      document.addEventListener("visibilitychange", () => { if (pending) reloadNow(); });
    }
    const kick = () => void flush();
    void recoverInterrupted().then(kick);
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    const t = setInterval(kick, 15000);
    return () => { clearInterval(t); window.removeEventListener("online", kick); };
  }, []);
  return null;
}
