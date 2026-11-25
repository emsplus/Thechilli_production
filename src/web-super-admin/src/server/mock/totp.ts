import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the mock backend, matching platform-core so a real authenticator app works in demos. */
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const newSecret = () => {
  let bits = "";
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, "0");
  return bits.match(/.{5}/g)!.map((c) => ALPHA[parseInt(c, 2)]).join("");
};
const decode = (s: string) => {
  let bits = "";
  for (const c of s) bits += ALPHA.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
};
export const hotp = (secret: string, counter: number) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", decode(secret)).update(buf).digest();
  const off = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};
export const totpAt = (secret: string, atMs = Date.now()) => hotp(secret, Math.floor(atMs / 30_000));
/** Matched step (previous, current, next) newer than `lastStep`, or null. */
export const verifyTotp = (secret: string, code: string, lastStep: number | null, atMs = Date.now()): number | null => {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(atMs / 30_000);
  let hit: number | null = null;
  for (let s = now - 1; s <= now + 1; s++) if (hotp(secret, s) === c && (lastStep === null || s > lastStep)) hit = s;
  return hit;
};
