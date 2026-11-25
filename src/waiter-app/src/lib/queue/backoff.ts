export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2000, capMs: 120_000 };

/**
 * Exponential backoff with "equal jitter": half the exponential delay is fixed, half is random, so a restaurant of
 * tablets that all lose Wi-Fi together do not retry in lock step. `attempt` is the number of failures so far (>= 1).
 * `random` is injectable (returns [0,1)) so tests are deterministic.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random, o: BackoffOptions = DEFAULT_BACKOFF): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = Math.min(o.capMs, o.baseMs * 2 ** Math.min(n - 1, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}
