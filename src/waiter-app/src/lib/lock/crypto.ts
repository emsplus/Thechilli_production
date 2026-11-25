/**
 * WebCrypto helpers for the MPIN vault. Nothing here stores anything.
 *
 * Key hierarchy (see vault.ts):
 *   DEK  random AES-256-GCM key; encrypts the session (access + refresh token). Never stored in the clear.
 *   KEK(pin)  PBKDF2-SHA256(MPIN, random 16-byte salt, PBKDF2_ITERATIONS) -> AES-256-GCM key that wraps the DEK.
 *   KEK(bio)  random 32 bytes kept by the biometric plugin in a Keychain item / Keystore key that only opens after a
 *             successful Face ID / fingerprint (hardware-enforced); wraps the DEK a second time.
 * A wrong MPIN fails the AES-GCM tag check when unwrapping the DEK: that tag is the only "verifier"; the MPIN itself and any
 * hash of it are never stored.
 */
export const PBKDF2_ITERATIONS = 310_000;

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Secure crypto is not available on this device");
  return s;
};

export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

export function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Sealed { iv: string; ct: string }

export async function pinKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const rawKey = (raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> =>
  subtle().importKey("raw", raw, { name: "AES-GCM" }, false, usages);

export async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, data));
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Throws when the key is wrong (GCM tag mismatch) or the data was tampered with. */
export async function open(key: CryptoKey, s: Sealed, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(s.iv), additionalData: new TextEncoder().encode(aad) }, key, fromB64(s.ct));
  return new Uint8Array(pt);
}

export const sealText = (key: CryptoKey, text: string, aad: string) => seal(key, new TextEncoder().encode(text), aad);
export const openText = async (key: CryptoKey, s: Sealed, aad: string) => new TextDecoder().decode(await open(key, s, aad));
