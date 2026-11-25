"use client";
import { useEffect } from "react";
import { isNative } from "@/lib/native/platform";

export function SwRegister() {
  useEffect(() => {
    // The native shell ships its assets in the APK, so no service worker there.
    if (!isNative() && process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* offline shell is best-effort */ });
    }
  }, []);
  return null;
}
