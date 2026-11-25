import { ROLLBACK_SLACK_MS, elapsed, type Tick } from "../clock";

/**
 * MPIN lock rules (pure, unit-tested in policy.test.ts). No storage, no clocks: callers pass `now`.
 * Clock rollback (D-06): the wall clock can be set back, so the auto-lock and the wrong-MPIN wait also use a monotonic reading
 * (lib/clock.ts) and a wall clock earlier than the recorded moment counts as "locked" / "keep the penalty".
 *
 * - 5 wrong MPINs in a row wipe the saved session on this phone (full email + password sign-in again).
 * - Each wrong MPIN before that makes the next try wait longer (the wait survives an app restart: it is stored as a deadline).
 * - Auto-lock: the app locks when it comes back after being in the background for at least the chosen minutes;
 *   "restart" locks only on a cold start.
 */
export const MAX_ATTEMPTS = 5;
export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Wait before the next try, by number of wrong MPINs so far (index = fails). Last entry repeats. */
export const DELAYS_MS = [0, 0, 2_000, 10_000, 30_000];

/** `until` = wall-clock deadline of the wait, `at` = wall-clock moment the last wrong MPIN was recorded (older saves have no `at`). */
export interface AttemptState { fails: number; until: number; at?: number }
export const NO_ATTEMPTS: AttemptState = { fails: 0, until: 0 };

export type FailOutcome = { wipe: true; state: AttemptState } | { wipe: false; state: AttemptState; remaining: number; waitMs: number };

export function delayAfter(fails: number): number {
  if (fails <= 0) return 0;
  return DELAYS_MS[Math.min(fails, DELAYS_MS.length - 1)];
}

/** A wrong MPIN. The 5th one wipes. */
export function registerFailure(s: AttemptState, now: number): FailOutcome {
  const fails = s.fails + 1;
  if (fails >= MAX_ATTEMPTS) return { wipe: true, state: NO_ATTEMPTS };
  const waitMs = delayAfter(fails);
  return { wipe: false, state: { fails, until: now + waitMs, at: now }, remaining: MAX_ATTEMPTS - fails, waitMs };
}

/**
 * Milliseconds the keypad must still wait (0 = may try now), and the state to store back.
 * `now` is the wall clock; `monoLeft` is the wait left by the monotonic clock of THIS app run (undefined after a restart, when
 * only the stored wall-clock deadline is known). Rules:
 *  - same run: the monotonic wait is exact and wins, whatever the wall clock was set to;
 *  - after a restart, a wall clock earlier than the moment the wrong MPIN was recorded is a rollback: the full wait starts again
 *    (stored re-anchored, so a correct clock afterwards does not add more), never "no wait";
 *  - otherwise the stored deadline counts, and never more than the full delay.
 */
export function checkWait(s: AttemptState, now: number, monoLeft?: number): { left: number; state: AttemptState } {
  const full = delayAfter(s.fails);
  if (full <= 0) return { left: 0, state: s };
  const rolledBack = s.at !== undefined && now < s.at - ROLLBACK_SLACK_MS;
  let left: number;
  if (monoLeft !== undefined) left = Math.min(Math.max(0, monoLeft), full);
  else if (rolledBack) left = full;
  else left = Math.min(Math.max(0, s.until - now), full);
  const state = rolledBack && left > 0 ? { ...s, at: now, until: now + left } : s;
  return { left, state };
}

/** Wall-clock only view of checkWait (a clock set backwards never waits more than the full delay). */
export const waitLeft = (s: AttemptState, now: number): number => checkWait(s, now).left;

export const isValidPin = (pin: string): boolean => new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);

/** Obvious MPINs refused at setup: all one digit, or a straight run up or down (1234, 987654). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  return (step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step);
}

/** Auto-lock choices offered in More > Security. `0` = only when the app restarts. */
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 0] as const;
export type AutoLock = (typeof AUTO_LOCK_CHOICES)[number];
export const DEFAULT_AUTO_LOCK: AutoLock = 5;
export const autoLockLabel = (m: AutoLock): string => (m === 0 ? "Only when the app restarts" : m === 1 ? "After 1 minute" : `After ${m} minutes`);
export const parseAutoLock = (v: unknown): AutoLock => ((AUTO_LOCK_CHOICES as readonly number[]).includes(Number(v)) && v !== null && v !== "" ? (Number(v) as AutoLock) : DEFAULT_AUTO_LOCK);

/**
 * Coming back to the foreground: lock if the app was away for at least the chosen time, or if the wall clock is earlier than when it
 * went away (a clock set back to dodge the timer). Numbers are wall-clock only; the app passes `Tick`s (lib/clock.ts).
 */
export function shouldLockOnResume(hidden: Tick | number | null, now: Tick | number, minutes: AutoLock): boolean {
  if (hidden === null || minutes === 0) return false;
  const e = elapsed(hidden, now);
  return e.rolledBack || e.ms >= minutes * 60_000;
}
