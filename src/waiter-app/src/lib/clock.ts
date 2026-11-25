/**
 * Clocks for lock and throttle decisions (D-06 of docs/testing/BREAK_CHAOS_REPORT.md).
 *
 * The wall clock (Date.now) can be set by the user at any time, forwards or backwards. A "time since" computed from it alone can be
 * made negative or huge on purpose: a clock set back while the app is in the background defeated the MPIN auto-lock, and a throttle
 * ("not more than once per 5 s") read as "not yet" for hours. So every duration is taken from two readings:
 *  - `mono`: performance.now(), a monotonic clock the user cannot set (it can stop while the phone sleeps, so it may be too small);
 *  - `wall`: Date.now(), which counts the sleep but can be moved.
 * The elapsed time is the LARGER of the two (a clock set forwards can only lock earlier, never later), and a wall clock that is
 * earlier than the recorded moment is a rollback: callers treat it as "locked" / "keep the penalty" instead of trusting the difference.
 */
export interface Tick { wall: number; mono: number }

/** Monotonic milliseconds (0 where the platform has no performance.now). */
export const monoNow = (): number => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : 0);
export const tickNow = (): Tick => ({ wall: Date.now(), mono: monoNow() });

/** A wall clock this much earlier than the recorded moment is a rollback (smaller NTP corrections are ignored). */
export const ROLLBACK_SLACK_MS = 2000;

/** True where `performance.now` is missing: `monoNow()` is then a constant 0, which no wait can be counted down on (callers use the wall clock). */
export const hasMono = (): boolean => typeof performance !== "undefined" && typeof performance.now === "function";

const asTick = (t: Tick | number): Tick => (typeof t === "number" ? { wall: t, mono: Number.NaN } : t);

export interface Elapsed { ms: number; rolledBack: boolean }
/** Time between two readings. Plain numbers are wall-clock only (tests, stored values). */
export function elapsed(then: Tick | number, now: Tick | number): Elapsed {
  const a = asTick(then), b = asTick(now);
  const wall = b.wall - a.wall;
  const mono = b.mono - a.mono;
  return { ms: Math.max(wall, Number.isFinite(mono) ? mono : 0, 0), rolledBack: wall < -ROLLBACK_SLACK_MS };
}
