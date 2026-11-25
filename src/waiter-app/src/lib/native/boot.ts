/** Hooks into the boot guard (bootGuard.ts). Every function is safe to call anywhere: it does nothing outside the Android shell. */
interface Boot { stage?: (s: string) => void; ready?: () => void }
const boot = (): Boot | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { __chilliBoot?: Boot }).__chilliBoot);

export const bootStage = (s: string): void => { try { boot()?.stage?.(s); } catch { /* diagnostics only */ } };
/** The app left the splash page: the "did not start" panel is not needed any more. */
export const bootReady = (): void => { try { boot()?.ready?.(); } catch { /* diagnostics only */ } };

/** A native / storage call that never answers must not freeze startup: resolves `fallback` after `ms` (or when it rejects). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}
