/**
 * Detects loss of the IndexedDB offline queue (e.g. Android WebView evicting site data under storage pressure).
 * A marker id is written to both IndexedDB and localStorage. If localStorage has a marker but IndexedDB does not hold
 * the same one, the database was wiped behind our back. localStorage also records how many ops were unsent so the
 * warning can say what was probably lost.
 */
export interface IntegrityDeps {
  getMarker(): Promise<string | null>;
  putMarker(id: string): Promise<void>;
  ls: { get(k: string): string | null; set(k: string, v: string): void };
  newId(): string;
}
export type IntegrityResult =
  | { status: "fresh" | "ok" }
  | { status: "lost"; pendingLost: number }
  | { status: "unavailable" };

export const MARKER_KEY = "waiter.idb.marker";
export const PENDING_KEY = "waiter.queue.pending";

export async function checkIntegrity(d: IntegrityDeps): Promise<IntegrityResult> {
  try {
    const ls = d.ls.get(MARKER_KEY);
    const idb = await d.getMarker();
    if (ls && idb === ls) return { status: "ok" };
    if (!ls && idb) { d.ls.set(MARKER_KEY, idb); return { status: "ok" }; }
    const fresh = d.newId();
    await d.putMarker(fresh);
    d.ls.set(MARKER_KEY, fresh);
    if (!ls) return { status: "fresh" };
    const pendingLost = Number(d.ls.get(PENDING_KEY) ?? 0) || 0;
    d.ls.set(PENDING_KEY, "0");
    // Nothing unsent was in the queue: the menu cache is re-downloaded and nothing the waiter did is gone, so no alarm
    // (a browser profile restored without its IndexedDB, or a cleared WebView cache, used to show a false red banner).
    if (!pendingLost) return { status: "fresh" };
    return { status: "lost", pendingLost };
  } catch { return { status: "unavailable" }; }
}
