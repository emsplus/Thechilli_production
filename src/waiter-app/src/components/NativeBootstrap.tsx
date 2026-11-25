"use client";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { SplashScreen } from "@capacitor/splash-screen";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { auth } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";
import { runStartupChecks } from "@/lib/native/integrityState";
import { PageBackground } from "@/lib/native/pageBackground";
import { isNative } from "@/lib/native/platform";
import { statusBarForApp, statusBarForSplash } from "@/lib/native/statusBar";
import { bootReady, bootStage } from "@/lib/native/boot";
import { lockState } from "@/lib/lock/state";

/** Screens where the hardware back button leaves the app instead of navigating. */
const ROOTS = new Set(["/", "/welcome", "/login", "/mpin", "/counter", "/tables", "/tables/"]);

/** Startup work for every platform plus Android-only wiring (back button, keyboard, splash). Renders nothing. */
export function NativeBootstrap() {
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);

  /** Splash red only while the splash itself is showing (not over the lock screen); everywhere else the page colour. */
  const barsForScreen = () => { if ((pathRef.current === "/" || pathRef.current === "") && !lockState.get().locked) statusBarForSplash(); else statusBarForApp(); };

  // Every screen change: the bars follow the screen (measured on Android dark: red bars stayed on every screen after the splash).
  useEffect(() => { pathRef.current = path; if (isNative()) barsForScreen(); if (path !== "/" && path !== "") bootReady(); }, [path]);

  useEffect(() => {
    bootStage("bootstrap");
    void runStartupChecks().catch(() => {}); // storage integrity check: best effort, never blocks or breaks startup
    if (!isNative()) return;
    if (pathRef.current !== "/" && pathRef.current !== "") statusBarForApp(); // "/" is the splash: it sets its own bar
    // The web view paints the branded splash from static HTML, so the native launch screen can go right away
    // (it used to wait for the secure-storage read, leaving a blank page in between on slow starts).
    // Next frame: the static splash HTML is on screen underneath, so the hand-over has no blank frame.
    // Hide never depends on a single path: rAF does not run in a hidden/slow web view, so a timer hides it too (the boot guard in
    // layout.tsx and MainActivity add a hard 3 s native fallback on top).
    let hidden = false;
    const hideSplash = () => { if (hidden) return; hidden = true; void SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {}); bootStage("splash-hidden"); };
    const hideTimer = setTimeout(hideSplash, 1000);
    requestAnimationFrame(() => {
      hideSplash();
      // After the 200 ms fade: the red web view background (kept so launch -> splash never flashes) would otherwise show
      // behind the iOS status bar on the dark in-app screens.
      if (Capacitor.getPlatform() === "ios") setTimeout(() => { void PageBackground.apply().catch(() => {}); }, 300);
      // Android: ending the launch splash installs the post-splash theme, which resets the bar colours set before it (measured:
      // splash bars turned pale). Apply the current screen's bars again afterwards.
      if (Capacitor.getPlatform() === "android") setTimeout(barsForScreen, 350);
    });
    void auth.hydrate().catch(() => {});

    const handles: Promise<{ remove: () => Promise<void> }>[] = [];
    handles.push(App.addListener("backButton", () => {
      if (lockState.get().locked || (ROOTS.has(pathRef.current.replace(/(.)\/$/, "$1")) || pathRef.current.replace(/(.)\/$/, "$1") === homeRouteNow())) void App.exitApp(); // the lock screen is never stepped around
      else if (window.history.length > 1) router.back();
      else router.replace(homeRouteNow());
    }));
    const show = () => {
      document.body.classList.add("kb-open");
      // Let the WebView resize first, then keep the focused field visible.
      setTimeout(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "center", behavior: "smooth" }), 50);
    };
    // Back in the foreground: refresh orders, tables and menu at once (lib/liveSync.ts), not on the next 10 s tick.
    handles.push(App.addListener("resume", () => window.dispatchEvent(new Event("waiter-resume"))));
    handles.push(Keyboard.addListener("keyboardDidShow", show));
    handles.push(Keyboard.addListener("keyboardDidHide", () => document.body.classList.remove("kb-open")));
    return () => { clearTimeout(hideTimer); handles.forEach((h) => void h.then((x) => x.remove()).catch(() => {})); };
  }, [router]);
  return null;
}
