"use client";
import { useEffect } from "react";
import { endPinSession } from "@/lib/counter/actions";
import { shouldIdleLock } from "@/lib/counter/core";
import { counterState } from "@/lib/counter/state";
import { tickNow } from "@/lib/clock";

/**
 * Shared counter tablet only: ends the PIN session after the server's idle time without a touch (a little before the
 * server does, so the next tap never hits a dead session), including after the tablet slept. AppShell then shows the roster.
 */
export function CounterGate() {
  useEffect(() => {
    let last = tickNow();
    const touch = () => { last = tickNow(); };
    const check = () => {
      const s = counterState.get().session;
      if (s && shouldIdleLock(last, tickNow(), s.idleSeconds)) void endPinSession("idle_lock");
    };
    const off = counterState.subscribe(touch); // a new sign-in starts the clock again
    const vis = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    document.addEventListener("visibilitychange", vis);
    const h = setInterval(check, 15_000);
    return () => { off(); clearInterval(h); window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return null;
}
