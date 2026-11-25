/** Splash and first-launch (welcome) decisions. Pure functions plus a storage flag that never throws. */
export const WELCOME_KEY = "chilli.welcomeSeen";
/** How long the splash stays up on a cold start. */
export const SPLASH_MS = 1200;

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function hasSeenWelcome(store: Store | null = defaultStore()): boolean {
  try { return store?.getItem(WELCOME_KEY) === "1"; } catch { return false; }
}
export function markWelcomeSeen(store: Store | null = defaultStore()): void {
  try { store?.setItem(WELCOME_KEY, "1"); } catch { /* private mode / blocked storage: the welcome screen may show again, harmless */ }
}

/** Splash is for signed-out cold starts only, and never when the user asked the OS for reduced motion. */
export function shouldShowSplash(o: { signedIn: boolean; reducedMotion: boolean }): boolean {
  return !o.signedIn && !o.reducedMotion;
}

/**
 * How much longer the splash stays once auth is known. The splash is painted from the static HTML at first paint, so the
 * time already spent loading JS and reading secure storage counts towards SPLASH_MS (never 1.2 s ON TOP of a slow start).
 * Signed-in and reduced-motion users go on immediately.
 */
export function splashHoldMs(o: { signedIn: boolean; reducedMotion: boolean; elapsedMs: number }): number {
  if (!shouldShowSplash(o)) return 0;
  return Math.max(0, Math.round(SPLASH_MS - Math.max(0, o.elapsedMs)));
}

/** Where the app goes once the (optional) splash is over. */
export function nextRoute(o: { signedIn: boolean; seenWelcome: boolean; counter?: boolean; /** Business type: the floor for a restaurant, the menu (new order) for a kitchen. Default: the floor. */ home?: "/tables" | "/menu" }): "/tables" | "/menu" | "/welcome" | "/login" | "/counter" {
  if (o.signedIn) return o.home ?? "/tables";
  if (o.counter) return "/counter"; // shared counter tablet: the roster, never the email sign-in
  return o.seenWelcome ? "/login" : "/welcome";
}
