import { open, openText, pinKey, randomBytes, rawKey, seal, sealText, fromB64, toB64, PBKDF2_ITERATIONS, type Sealed } from "./crypto";
import { hasMono, monoNow } from "../clock";
import { NO_ATTEMPTS, checkWait, isValidPin, registerFailure, type AttemptState } from "./policy";

/**
 * The MPIN vault: the signed-in session (access + refresh token) sealed so it can only be read after the MPIN or a
 * biometric check. Storage is injected: on the phone `kv` is the Keychain / Keystore plugin (lib/lock/native.ts); tests use
 * a Map. Nothing is ever written to localStorage.
 */
export interface Kv { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; remove(k: string): Promise<void> }
/** Biometric-protected secret (Keychain item with biometry access control / Keystore key that needs BiometricPrompt). */
export interface BioStore {
  /** Throws when the user cancels or the hardware refuses. */
  save(secretB64: string): Promise<void>;
  /** Shows the system Face ID / fingerprint prompt. Throws on cancel / failure / no secret. */
  load(): Promise<string>;
  remove(): Promise<void>;
}
export interface Session { access: string; refresh: string }

interface Meta { v: 1; len: number; salt: string; iter: number; pin: Sealed; bio: Sealed | null; session: Sealed | null }

export const META_KEY = "waiter.lock.meta";
export const ATTEMPTS_KEY = "waiter.lock.attempts";
const AAD = { pin: "chilli.lock.v1.pin", bio: "chilli.lock.v1.bio", session: "chilli.lock.v1.session" };

export type PinResult =
  | { ok: true; session: Session | null }
  | { ok: false; reason: "wrong"; remaining: number; waitMs: number }
  | { ok: false; reason: "wait"; waitMs: number }
  | { ok: false; reason: "wiped" }
  | { ok: false; reason: "no_mpin" };
export type BioResult = { ok: true; session: Session | null } | { ok: false; reason: "cancelled" | "unavailable" | "no_mpin" };

export class LockVault {
  /** Data key, only while unlocked (non-extractable CryptoKey: it cannot be read back out of memory as bytes). */
  private dek: CryptoKey | null = null;
  /** Wait of the last wrong MPIN on the monotonic clock of this run (D-06): a clock set back or forwards cannot shorten it. Lost on restart. */
  private monoWait: { fails: number; until: number } | null = null;
  constructor(private kv: Kv, private bio: BioStore | null, private now: () => number = Date.now, private mono: () => number = monoNow) {}

  private async meta(): Promise<Meta | null> {
    const raw = await this.kv.get(META_KEY);
    if (!raw) return null;
    try { const m = JSON.parse(raw) as Meta; return m && m.v === 1 ? m : null; } catch { return null; }
  }
  private writeMeta(m: Meta) { return this.kv.set(META_KEY, JSON.stringify(m)); }

  async attempts(): Promise<AttemptState> {
    try { const a = JSON.parse((await this.kv.get(ATTEMPTS_KEY)) ?? "null") as AttemptState | null; return a && typeof a.fails === "number" ? a : NO_ATTEMPTS; }
    catch { return NO_ATTEMPTS; }
  }
  private setAttempts(a: AttemptState) {
    if (!a.fails) this.monoWait = null;
    return a.fails ? this.kv.set(ATTEMPTS_KEY, JSON.stringify(a)) : this.kv.remove(ATTEMPTS_KEY);
  }

  /** The default monotonic clock is a constant 0 where performance.now is missing: a wait could never count down on it, so the wall clock is used. */
  private useMono(): boolean { return this.mono !== monoNow || hasMono(); }

  /** Milliseconds the keypad must still wait before the next MPIN try (0 = may try). Stored again when a clock rollback restarts the wait. */
  async waitMs(): Promise<number> {
    const a = await this.attempts();
    const monoLeft = this.useMono() && this.monoWait && this.monoWait.fails === a.fails ? Math.max(0, this.monoWait.until - this.mono()) : undefined;
    const r = checkWait(a, this.now(), monoLeft);
    if (r.state !== a) await this.setAttempts(r.state);
    return r.left;
  }

  async enabled(): Promise<boolean> { return (await this.meta()) !== null; }
  async pinLength(): Promise<number | null> { return (await this.meta())?.len ?? null; }
  async biometricOn(): Promise<boolean> { return !!(await this.meta())?.bio && !!this.bio; }
  get unlocked(): boolean { return this.dek !== null; }

  /** New MPIN for the current session. Replaces any earlier vault. */
  async setup(pin: string, session: Session): Promise<void> {
    if (!isValidPin(pin)) throw new Error("MPIN must be 4 to 6 digits");
    await this.wipe();
    const dekRaw = randomBytes(32);
    const salt = randomBytes(16);
    const kek = await pinKey(pin, salt, PBKDF2_ITERATIONS);
    this.dek = await rawKey(dekRaw);
    const m: Meta = { v: 1, len: pin.length, salt: toB64(salt), iter: PBKDF2_ITERATIONS, pin: await seal(kek, dekRaw, AAD.pin), bio: null, session: null };
    dekRaw.fill(0);
    await this.writeMeta(m);
    await this.saveSession(session);
  }

  /** Keeps the (rotated) session sealed. Only possible while unlocked. */
  async saveSession(session: Session | null): Promise<boolean> {
    const m = await this.meta();
    if (!m || !this.dek) return false;
    m.session = session ? await sealText(this.dek, JSON.stringify(session), AAD.session) : null;
    await this.writeMeta(m);
    return true;
  }

  private async readSession(m: Meta): Promise<Session | null> {
    if (!m.session || !this.dek) return null;
    try { return JSON.parse(await openText(this.dek, m.session, AAD.session)) as Session; } catch { return null; }
  }

  /** Checks the MPIN and returns the raw data key, counting failures (wipe on the 5th). */
  private async checkPin(pin: string): Promise<{ dekRaw: Uint8Array<ArrayBuffer>; m: Meta } | Exclude<PinResult, { ok: true }>> {
    const m = await this.meta();
    if (!m) return { ok: false, reason: "no_mpin" };
    const a = await this.attempts();
    const wait = await this.waitMs();
    if (wait > 0) return { ok: false, reason: "wait", waitMs: wait };
    try {
      const dekRaw = await open(await pinKey(pin, fromB64(m.salt), m.iter), m.pin, AAD.pin);
      await this.setAttempts(NO_ATTEMPTS);
      return { dekRaw, m };
    } catch {
      const f = registerFailure(a, this.now());
      if (f.wipe) { await this.wipe(); return { ok: false, reason: "wiped" }; }
      await this.setAttempts(f.state);
      this.monoWait = { fails: f.state.fails, until: this.mono() + f.waitMs };
      return { ok: false, reason: "wrong", remaining: f.remaining, waitMs: f.waitMs };
    }
  }

  async unlockWithPin(pin: string): Promise<PinResult> {
    const r = await this.checkPin(pin);
    if ("ok" in r) return r;
    this.dek = await rawKey(r.dekRaw);
    r.dekRaw.fill(0);
    return { ok: true, session: await this.readSession(r.m) };
  }

  async unlockWithBiometric(): Promise<BioResult> {
    const m = await this.meta();
    if (!m) return { ok: false, reason: "no_mpin" };
    if (!m.bio || !this.bio) return { ok: false, reason: "unavailable" };
    let secret: string;
    try { secret = await this.bio.load(); } catch { return { ok: false, reason: "cancelled" }; }
    try {
      const dekRaw = await open(await rawKey(fromB64(secret)), m.bio, AAD.bio);
      this.dek = await rawKey(dekRaw);
      dekRaw.fill(0);
    } catch {
      // Enrolment changed (a new fingerprint invalidates the key) or the item is gone: biometrics off, MPIN still works.
      await this.disableBiometric();
      return { ok: false, reason: "unavailable" };
    }
    await this.setAttempts(NO_ATTEMPTS);
    return { ok: true, session: await this.readSession(m) };
  }

  /** Checks the MPIN only (counts as a try, like the lock screen). */
  async verify(pin: string): Promise<PinResult> {
    const r = await this.checkPin(pin);
    if ("ok" in r) return r;
    r.dekRaw.fill(0);
    return { ok: true, session: null };
  }

  async changePin(current: string, next: string): Promise<PinResult> {
    if (!isValidPin(next)) throw new Error("MPIN must be 4 to 6 digits");
    const r = await this.checkPin(current);
    if ("ok" in r) return r;
    const salt = randomBytes(16);
    r.m.salt = toB64(salt); r.m.iter = PBKDF2_ITERATIONS; r.m.len = next.length;
    r.m.pin = await seal(await pinKey(next, salt, PBKDF2_ITERATIONS), r.dekRaw, AAD.pin);
    this.dek = await rawKey(r.dekRaw);
    r.dekRaw.fill(0);
    await this.writeMeta(r.m);
    return { ok: true, session: null };
  }

  /** Turning biometrics on needs the MPIN (the data key is only ever unwrapped from it). */
  async enableBiometric(pin: string): Promise<PinResult | { ok: false; reason: "cancelled" | "unavailable" }> {
    if (!this.bio) return { ok: false, reason: "unavailable" };
    const r = await this.checkPin(pin);
    if ("ok" in r) return r;
    const secret = randomBytes(32);
    try { await this.bio.save(toB64(secret)); } catch { r.dekRaw.fill(0); return { ok: false, reason: "cancelled" }; }
    r.m.bio = await seal(await rawKey(secret), r.dekRaw, AAD.bio);
    secret.fill(0); r.dekRaw.fill(0);
    await this.writeMeta(r.m);
    return { ok: true, session: null };
  }

  async disableBiometric(): Promise<void> {
    const m = await this.meta();
    if (m) { m.bio = null; await this.writeMeta(m); }
    try { await this.bio?.remove(); } catch { /* nothing stored */ }
  }

  /** Forget the data key: the session cannot be read again without the MPIN / biometrics. */
  lock() { this.dek = null; }

  /** Removes everything this vault stored (sign out of this phone, Forgot MPIN, 5 wrong MPINs). */
  async wipe(): Promise<void> {
    this.dek = null; this.monoWait = null;
    await this.kv.remove(META_KEY);
    await this.kv.remove(ATTEMPTS_KEY);
    try { await this.bio?.remove(); } catch { /* nothing stored */ }
  }
}
