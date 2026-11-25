import { API_BASE, api, auth, deviceHeaders } from "../api";
import { secureKv } from "../lock/native";
import { lockState, vault } from "../lock/state";
import { tokenVault } from "../native/secureTokens";
import { defaultSessionGateway } from "../session";
import { fetchRoster, normaliseDeviceToken, pinLogin, pinLogout, type LogoutReason, type PinLoginResult, type RosterResult } from "./core";
import { COUNTER_TOKEN_KEY, counterState } from "./state";

const f = (url: string, init?: RequestInit) => fetch(url, init);

/**
 * Turns this install into a counter tablet. The credential is checked against the roster first; only then is any phone
 * session on this device ended (a tablet never keeps one) and the credential saved in Keychain / Keystore.
 */
export async function setupCounter(raw: string): Promise<RosterResult | { ok: false; reason: "invalid" }> {
  const token = normaliseDeviceToken(raw);
  if (!token) return { ok: false, reason: "invalid" };
  const r = await fetchRoster(f, API_BASE, token);
  if (!r.ok) return r;
  if (auth.refreshToken) await api.logout();
  await vault.wipe();
  await tokenVault.clear();
  auth.clear();
  lockState.set({ enabled: false, locked: false, biometric: false, pinLength: null });
  await secureKv.set(COUNTER_TOKEN_KEY, token);
  counterState.set({ deviceToken: token, session: null, ended: null });
  return r;
}

export async function loadRoster(): Promise<RosterResult> {
  const t = counterState.get().deviceToken;
  if (!t) return { ok: false, reason: "removed" };
  return fetchRoster(f, API_BASE, t);
}

/** PIN sign-in. On success the session is in memory only and the shift starts at the tablet's outlet (no outlet screen). */
export async function signInWithPin(userId: string, pin: string, outletName?: string): Promise<PinLoginResult> {
  const t = counterState.get().deviceToken;
  if (!t) return { ok: false, reason: "removed" };
  const r = await pinLogin(f, API_BASE, t, userId, pin, deviceHeaders());
  if (!r.ok) return r;
  counterState.set({ session: r.session, ended: null });
  // The PIN answer does not carry the business type: ask /auth/me now so the tablet opens on the right screen (offline: the last known one).
  await api.me().catch(() => undefined);
  const shift = defaultSessionGateway.currentShift();
  if (!shift || shift.outlet_id !== r.session.outletId) {
    try { await defaultSessionGateway.openShift(r.session.outletId, outletName); } catch { /* the outlet screen will ask */ }
  }
  return r;
}

/** Switch user / lock / idle: ends the PIN session on the server (best effort) and goes back to the roster. */
export async function endPinSession(reason: LogoutReason): Promise<void> {
  const s = counterState.get().session;
  counterState.set({ session: null, ended: reason === "idle_lock" ? "idle" : null });
  if (s) await pinLogout(f, API_BASE, s.access, reason);
}

/** Forget the tablet credential on this device (it can also be revoked in business-admin > Devices). */
export async function removeCounter(): Promise<void> {
  await endPinSession("logout");
  await secureKv.remove(COUNTER_TOKEN_KEY);
  counterState.set({ deviceToken: null, ended: null });
}
