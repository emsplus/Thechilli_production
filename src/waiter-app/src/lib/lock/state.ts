import { isNative } from "../native/platform";
import { DEFAULT_AUTO_LOCK, parseAutoLock, type AutoLock } from "./policy";
import { LockVault, type Session } from "./vault";
import { bioStore, secureKv } from "./native";
import { withTimeout } from "../native/boot";

/**
 * App-wide lock status. `api.ts` (auth) reads it to decide where the session lives; the lock screen and More > Security
 * change it through lib/lock/actions.ts. Native only: on the web `available` is false and nothing here runs.
 *
 * locked + no tokens in memory  = cold start (the session is still sealed in the vault).
 * locked + tokens in memory     = came back from the background after the auto-lock time: the screen is covered, the offline
 *                                 queue keeps sending (it needs the session), nothing can be seen or tapped until unlock.
 */
export interface LockStatus { available: boolean; ready: boolean; enabled: boolean; locked: boolean; biometric: boolean; pinLength: number | null }

let status: LockStatus = { available: false, ready: false, enabled: false, locked: false, biometric: false, pinLength: null };
const listeners = new Set<() => void>();
const set = (p: Partial<LockStatus>) => { status = { ...status, ...p }; listeners.forEach((f) => f()); };

export const vault = new LockVault(secureKv, bioStore);

export const lockState = {
  get: () => status,
  subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  set,
};

let initing: Promise<LockStatus> | null = null;
/** Reads the vault once at start. A set-up vault starts locked. */
export function initLock(): Promise<LockStatus> {
  initing ??= withTimeout((async () => {
    if (!isNative()) { set({ ready: true }); return status; }
    const enabled = await vault.enabled();
    set({ available: true, ready: true, enabled, locked: enabled, biometric: enabled && (await vault.biometricOn()), pinLength: await vault.pinLength() });
    return status;
  })(), 4000, status).then((s) => {
    // Timed out or failed: carry on without the lock screen (the login screen shows) rather than staying on the splash.
    if (!status.ready) set({ available: isNative(), ready: true });
    return s;
  });
  return initing;
}

/** Seals a rotated / new session while the vault is open. False = no vault (caller stores it the old way). */
export async function persistSession(s: Session | null): Promise<boolean> {
  if (!status.enabled) return false;
  await vault.saveSession(s);
  return true;
}

const AUTO_KEY = "waiter.lock.autoLock";
const SKIP_KEY = "waiter.lock.skipped";
const WIPED_KEY = "waiter.lock.wiped";
export const prefs = {
  autoLock(): AutoLock { try { return parseAutoLock(localStorage.getItem(AUTO_KEY)); } catch { return DEFAULT_AUTO_LOCK; } },
  setAutoLock(m: AutoLock) { try { localStorage.setItem(AUTO_KEY, String(m)); } catch { /* default stays */ } set({}); },
  /** "Skip for now" is allowed once per phone; after that the MPIN offer has no skip. */
  skipped(): boolean { try { return localStorage.getItem(SKIP_KEY) === "1"; } catch { return false; } },
  markSkipped() { try { localStorage.setItem(SKIP_KEY, "1"); } catch { /* ignore */ } },
  /** Set after 5 wrong MPINs so the sign-in screen can say why. */
  wiped(): boolean { try { return localStorage.getItem(WIPED_KEY) === "1"; } catch { return false; } },
  setWiped(v: boolean) { try { if (v) localStorage.setItem(WIPED_KEY, "1"); else localStorage.removeItem(WIPED_KEY); } catch { /* ignore */ } },
};
