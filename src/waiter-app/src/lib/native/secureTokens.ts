import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { withTimeout } from "./boot";

/**
 * Auth tokens live in Android Keystore-backed encrypted storage (iOS Keychain), never in localStorage, on native.
 * Only called when isNative() is true. Android auto-backup is disabled in the manifest so ciphertext is never restored
 * onto a device that lacks the Keystore key.
 */
export interface StoredTokens { access: string | null; refresh: string | null }
const A = "waiter.token", R = "waiter.refresh";

const get = (k: string): Promise<string | null> => withTimeout(SecureStorage.get(k).then((v) => (v as string | null) ?? null), 4000, null);

export const tokenVault = {
  async load(): Promise<StoredTokens> { return { access: await get(A), refresh: await get(R) }; },
  async save(access: string, refresh: string) { await SecureStorage.set(A, access); await SecureStorage.set(R, refresh); },
  async clear() { try { await SecureStorage.remove(A); await SecureStorage.remove(R); } catch { /* nothing stored */ } },
};
