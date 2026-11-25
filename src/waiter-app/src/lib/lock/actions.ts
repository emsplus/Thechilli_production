import { api, auth } from "../api";
import { tokenVault } from "../native/secureTokens";
import { lockState, prefs, vault } from "./state";
import type { BioResult, PinResult } from "./vault";

/**
 * Everything the MPIN screens do. Kept out of the components so the rules sit in one place:
 * - unlock puts the session from the vault into memory (never back into plain storage);
 * - 5 wrong MPINs, "Forgot MPIN", "Use password instead" and "Sign out of this phone" all wipe the vault and the tokens.
 */
const refresh = async () => lockState.set({ enabled: await vault.enabled(), biometric: await vault.biometricOn(), pinLength: await vault.pinLength() });

/** First MPIN, right after a password sign-in (or later from More > Security). Needs the session in memory. */
export async function setupMpin(pin: string): Promise<void> {
  const access = auth.token, refreshToken = auth.refreshToken;
  if (!access || !refreshToken) throw new Error("Sign in first");
  await vault.setup(pin, { access, refresh: refreshToken });
  await tokenVault.clear(); // the plain Keychain / Keystore copy goes: from now on only the sealed one exists
  lockState.set({ locked: false });
  await refresh();
}

function opened(session: { access: string; refresh: string } | null): boolean {
  if (!auth.token) {
    if (!session) return false;
    auth.setUnlocked(session);
  }
  prefs.setWiped(false);
  lockState.set({ locked: false });
  return true;
}

export type UnlockOutcome = PinResult | { ok: false; reason: "no_session" };
export async function unlockWithPin(pin: string): Promise<UnlockOutcome> {
  const r = await vault.unlockWithPin(pin);
  if (r.ok) return opened(r.session) ? r : (await forgetPhone(), { ok: false, reason: "no_session" });
  if (r.reason === "wiped") await wiped();
  return r;
}

export async function unlockWithBiometric(): Promise<BioResult | { ok: false; reason: "no_session" }> {
  const r = await vault.unlockWithBiometric();
  if (!r.ok) { await refresh(); return r; }
  return opened(r.session) ? r : (await forgetPhone(), { ok: false, reason: "no_session" });
}

/** 5 wrong MPINs: the vault is already gone; drop the in-memory session too and tell the sign-in screen. */
async function wiped() {
  prefs.setWiped(true);
  if (auth.refreshToken) await api.logout(); // locked after the background: the session was still in memory, end it on the server
  auth.clear();
  lockState.set({ enabled: false, locked: false, biometric: false, pinLength: null });
}

/** "Use password instead" / "Forgot MPIN": the sealed session cannot be opened, so this phone forgets it. */
export async function forgetPhone(): Promise<void> {
  if (auth.refreshToken) await api.logout(); // background lock: the session is still in memory, so end it on the server too
  await vault.wipe();
  auth.clear();
  lockState.set({ enabled: false, locked: false, biometric: false, pinLength: null });
}

/** More > Security > Sign out of this phone: ends the session on the server and wipes every local secret. */
export async function signOutPhone(): Promise<void> {
  await api.logout();
  await vault.wipe();
  auth.clear();
  lockState.set({ enabled: false, locked: false, biometric: false, pinLength: null });
}

export async function verifyMpin(pin: string): Promise<PinResult> {
  const r = await vault.verify(pin);
  if (!r.ok && r.reason === "wiped") await wiped();
  return r;
}

export async function changeMpin(current: string, next: string): Promise<PinResult> {
  const r = await vault.changePin(current, next);
  if (!r.ok && r.reason === "wiped") await wiped();
  await refresh();
  return r;
}

export async function enableBiometric(pin: string) {
  const r = await vault.enableBiometric(pin);
  if (!r.ok && r.reason === "wiped") await wiped();
  await refresh();
  return r;
}

export async function disableBiometric() { await vault.disableBiometric(); await refresh(); }

/** Turn the MPIN off (needs the MPIN): the session goes back to plain Keychain / Keystore storage. */
export async function removeMpin(pin: string): Promise<PinResult> {
  const r = await vault.unlockWithPin(pin);
  if (!r.ok) { if (r.reason === "wiped") await wiped(); return r; }
  await vault.wipe();
  if (auth.token && auth.refreshToken) await tokenVault.save(auth.token, auth.refreshToken);
  lockState.set({ enabled: false, locked: false, biometric: false, pinLength: null });
  return r;
}

export function lockNow() { if (lockState.get().enabled) lockState.set({ locked: true }); }
