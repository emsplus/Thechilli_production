"use client";

import { useSyncExternalStore } from "react";

/** The browser's own online flag (true on the server / first paint). Enough to gate features that need the API right now. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; },
    () => navigator.onLine,
    () => true,
  );
}
