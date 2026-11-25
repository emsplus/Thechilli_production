import { Capacitor } from "@capacitor/core";

/** True only inside the Capacitor Android shell. Always false on the web/PWA and during SSR/export. */
export const isNative = (): boolean => {
  try { return typeof window !== "undefined" && Capacitor.isNativePlatform(); } catch { return false; }
};
