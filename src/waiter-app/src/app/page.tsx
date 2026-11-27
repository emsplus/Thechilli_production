"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Splash } from "@/components/Splash";
import { auth } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";
import { counterState } from "@/lib/counter/state";
import { hasSeenWelcome, nextRoute, splashHoldMs } from "@/lib/firstLaunch";
import { statusBarForApp, statusBarForSplash } from "@/lib/native/statusBar";
import { bootReady, bootStage } from "@/lib/native/boot";
import { ADMIN_URL, getMode, openAdmin, setMode } from "@/lib/adminUrl";

/**
 * Cold-start entry. The splash is in the static HTML, so it is the first paint (no blank page while JS loads and the
 * token is read from secure storage). Signed-in and reduced-motion users leave as soon as auth is known; signed-out
 * users see it for SPLASH_MS in total, counted from first paint.
 */
export default function Home() {
  const r = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    statusBarForSplash();
    // MPIN set: the lock screen covers the splash; route once it is unlocked (or wiped, then to sign in).
    const unlocked = () => new Promise<void>((res) => {
      if (!auth.locked) { res(); return; }
      const off = auth.subscribe(() => { if (!auth.locked) { off(); res(); } });
    });
    void auth.hydrate().then(unlocked).then(() => {
      if (!live) return;
      const signedIn = !!auth.token;
      const go = () => { if (new URLSearchParams(window.location.search).get("mode") === "staff") setMode("staff"); /* "Back to staff login" from the admin site */ statusBarForApp(); bootStage("leave-splash"); bootReady(); if (ADMIN_URL && !counterState.active && getMode() === "admin") { openAdmin(true); return; } r.replace(nextRoute({ signedIn, seenWelcome: hasSeenWelcome(), counter: counterState.active, home: homeRouteNow() })); };
      const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const hold = splashHoldMs({ signedIn, reducedMotion, elapsedMs: typeof performance !== "undefined" ? performance.now() : 0 });
      if (hold > 0) timer = setTimeout(go, hold); else go();
    }).catch(() => { if (live) { statusBarForApp(); bootReady(); r.replace("/login"); } }); // a failed start must end on the sign-in screen, not on the logo
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [r]);
  return <Splash />;
}
