import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { AccessControl, BiometryType, NativeBiometric } from "@capgo/capacitor-native-biometric";
import { withTimeout } from "../native/boot";
import type { BioStore, Kv } from "./vault";

/**
 * Platform storage for the MPIN vault (native only; callers check isNative()).
 * - Kv: @aparajita/capacitor-secure-storage = iOS Keychain (KeychainSwift) / Android Keystore AES-GCM key + encrypted prefs.
 *   Its web fallback is localStorage, which is why the lock is never offered outside the native app.
 * - BioStore: @capgo/capacitor-native-biometric secure data with BIOMETRY_CURRENT_SET = iOS Keychain item with
 *   SecAccessControl(.biometryCurrentSet, WhenPasscodeSetThisDeviceOnly); Android Keystore key with
 *   setUserAuthenticationRequired(true) used through a BiometricPrompt CryptoObject. Enrolling a new finger / face deletes it.
 */
export const secureKv: Kv = {
  // 4 s cap: a Keystore that never answers must not freeze the start (see api.ts hydrate).
  get(k) { return withTimeout(SecureStorage.get(k).then((v) => (v as string | null) ?? null), 4000, null); },
  async set(k, v) { await SecureStorage.set(k, v); },
  async remove(k) { try { await SecureStorage.remove(k); } catch { /* not stored */ } },
};

const BIO_KEY = "in.chilli.staff.lock.bio";
export const bioStore: BioStore = {
  async save(secret) {
    await NativeBiometric.setData({ key: BIO_KEY, value: secret, accessControl: AccessControl.BIOMETRY_CURRENT_SET, title: "Turn on fingerprint unlock" });
  },
  async load() {
    const r = await NativeBiometric.getSecureData({ key: BIO_KEY, reason: "Unlock Chilli Staff", title: "Unlock Chilli Staff", negativeButtonText: "Use MPIN" });
    return r.value;
  },
  async remove() { try { await NativeBiometric.deleteData({ key: BIO_KEY }); } catch { /* not stored */ } },
};

export interface BioInfo { available: boolean; label: string; face: boolean }
export async function biometricInfo(): Promise<BioInfo> {
  try {
    const r = await NativeBiometric.isAvailable({ useFallback: false });
    const face = r.biometryType === BiometryType.FACE_ID || r.biometryType === BiometryType.FACE_AUTHENTICATION;
    const label = r.biometryType === BiometryType.FACE_ID ? "Face ID" : r.biometryType === BiometryType.TOUCH_ID ? "Touch ID" : face ? "Face unlock" : "Fingerprint";
    return { available: !!r.isAvailable, label, face };
  } catch { return { available: false, label: "Fingerprint", face: false }; }
}
