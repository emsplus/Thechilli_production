/**
 * "The kitchen board may have changed" (a bill was made at the counter): every open Kitchen screen of this browser reloads at once
 * instead of waiting for its next poll, so no stale ticket stays. Other devices pick it up on their own poll (10 s).
 */
const EVT = "pos-kitchen-changed";
const CHANNEL = "pos-kitchen";

export function notifyKitchenChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(EVT));
  try { const c = new BroadcastChannel(CHANNEL); c.postMessage("changed"); c.close(); } catch { /* no BroadcastChannel */ }
}

/** Calls `fn` when the counter says the kitchen changed (this tab or another tab). Returns the unsubscribe. */
export function onKitchenChanged(fn: () => void): () => void {
  window.addEventListener(EVT, fn);
  let c: BroadcastChannel | null = null;
  try { c = new BroadcastChannel(CHANNEL); c.onmessage = () => fn(); } catch { /* no BroadcastChannel */ }
  return () => { window.removeEventListener(EVT, fn); c?.close(); };
}
