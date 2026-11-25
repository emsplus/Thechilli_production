import { Network } from "@capacitor/network";
import { isNative } from "./platform";

/** Connectivity source. Native: Capacitor Network plugin (WebView navigator.onLine is unreliable). Web: window events. */
let online = typeof navigator === "undefined" ? true : navigator.onLine;
const subs = new Set<(o: boolean) => void>();
let started = false;

function set(o: boolean) { if (o !== online) { online = o; subs.forEach((f) => f(o)); } }

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (isNative()) {
    void Network.getStatus().then((s) => set(s.connected)).catch(() => {});
    void Network.addListener("networkStatusChange", (s) => set(s.connected));
  } else {
    window.addEventListener("online", () => set(true));
    window.addEventListener("offline", () => set(false));
  }
}

export const getOnline = () => online;
export function subscribeOnline(cb: (online: boolean) => void): () => void {
  start();
  subs.add(cb);
  return () => { subs.delete(cb); };
}
