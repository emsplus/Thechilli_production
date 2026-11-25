"use client";
import { App } from "@capacitor/app";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { LockScreen } from "./LockScreen";
import { isNative } from "@/lib/native/platform";
import { shouldLockOnResume } from "@/lib/lock/policy";
import { initLock, lockState, prefs } from "@/lib/lock/state";
import { bootReady } from "@/lib/native/boot";
import { tickNow, type Tick } from "@/lib/clock";

/**
 * Mounted once in the root layout. Native only:
 * - cold start with an MPIN: covers everything with the lock screen until unlocked;
 * - back from the background after the auto-lock time (More > Security, default 5 minutes): locks again;
 * - the OS app-switcher snapshot is hidden natively (iOS SceneDelegate cover, Android setRecentsScreenshotEnabled(false)).
 */
export function LockGate() {
  const router = useRouter();
  const st = useSyncExternalStore(lockState.subscribe, lockState.get, lockState.get);

  useEffect(() => {
    if (!isNative()) return;
    void initLock();
    let hiddenAt: Tick | null = null; // wall + monotonic reading: a clock set back in the background still locks (lib/clock.ts)
    const away = () => { hiddenAt ??= tickNow(); };
    const back = () => {
      const s = lockState.get();
      if (s.enabled && !s.locked && shouldLockOnResume(hiddenAt, tickNow(), prefs.autoLock())) lockState.set({ locked: true });
      hiddenAt = null;
    };
    const h = App.addListener("appStateChange", ({ isActive }) => (isActive ? back() : away()));
    const vis = () => (document.visibilityState === "hidden" ? away() : back());
    document.addEventListener("visibilitychange", vis);
    return () => { void h.then((x) => x.remove()); document.removeEventListener("visibilitychange", vis); };
  }, []);

  // The lock screen is a healthy "waiting for the MPIN": the boot guard must not call it a stuck splash (lib/native/bootGuard.ts).
  const locked = st.enabled && st.locked;
  useEffect(() => {
    if (locked) { bootReady(); document.documentElement.setAttribute("data-locked", "1"); } else document.documentElement.removeAttribute("data-locked");
  }, [locked]);

  const toSignIn = useCallback(() => router.replace("/login"), [router]);
  if (!st.enabled || !st.locked) return null;
  return <LockScreen onSignIn={toSignIn} />;
}
