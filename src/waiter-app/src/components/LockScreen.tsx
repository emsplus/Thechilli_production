"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keypad, PinDots } from "./Keypad";
import { LeafArt, Wave } from "./Scenery";
import { biometricInfo, type BioInfo } from "@/lib/lock/native";
import { forgetPhone, unlockWithBiometric, unlockWithPin } from "@/lib/lock/actions";
import { lockState, vault } from "@/lib/lock/state";
import { statusBarForApp } from "@/lib/native/statusBar";

export const wrongMessage = (remaining: number, waitMs: number): string => {
  const left = remaining === 1 ? "1 try left before this phone signs you out." : `${remaining} tries left.`;
  return `Wrong MPIN. ${left}${waitMs > 0 ? ` Wait ${Math.ceil(waitMs / 1000)} s.` : ""}`;
};

/**
 * Full-screen MPIN lock (peach entry styling): dots, big keypad, Face ID / fingerprint when turned on, "Use password instead"
 * and "Forgot MPIN?" (both = full email + password sign-in on this phone). The MPIN is checked as soon as its last digit is in.
 */
export function LockScreen({ onSignIn }: { onSignIn: () => void }) {
  const st = useSyncExternalStore(lockState.subscribe, lockState.get, lockState.get);
  const len = st.pinLength ?? 4;
  const [pin, setPin] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waitMs, setWaitMs] = useState(0);
  const [bio, setBio] = useState<BioInfo | null>(null);
  const autoTried = useRef(false);

  // A wait from earlier wrong MPINs survives a restart: read it and count down. The status bar takes the app's colours
  // (on a cold start the splash had set white icons, unreadable over this light screen).
  useEffect(() => {
    statusBarForApp();
    let live = true;
    void vault.waitMs().then((w) => { if (live) setWaitMs(w); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (waitMs <= 0) return;
    const h = setTimeout(() => setWaitMs((w) => Math.max(0, w - 1000)), Math.min(1000, waitMs));
    return () => clearTimeout(h);
  }, [waitMs]);

  const tryBio = useCallback(async () => {
    setMsg(null);
    const r = await unlockWithBiometric();
    if (!r.ok && r.reason === "unavailable") setMsg("Fingerprint / Face ID is off for this phone. Use your MPIN.");
    if (!r.ok && r.reason === "no_session") onSignIn();
  }, [onSignIn]);

  useEffect(() => {
    if (!st.biometric) return;
    void biometricInfo().then((b) => {
      setBio(b.available ? b : null);
      if (b.available && !autoTried.current) { autoTried.current = true; void tryBio(); } // offer it straight away, once
    });
  }, [st.biometric, tryBio]);

  async function onChange(v: string) {
    setPin(v); setMsg(null);
    if (v.length < len || busy) return;
    setBusy(true);
    const r = await unlockWithPin(v);
    setBusy(false); setPin("");
    if (r.ok) return;
    if (r.reason === "wrong") { setMsg(wrongMessage(r.remaining, r.waitMs)); setWaitMs(r.waitMs); setShake(true); setTimeout(() => setShake(false), 400); }
    else if (r.reason === "wait") setWaitMs(r.waitMs);
    else onSignIn(); // wiped (5 wrong) / no session / no MPIN: the sign-in screen explains
  }

  async function passwordInstead() { await forgetPhone(); onSignIn(); }

  return (
    <div className="entry lockscreen" role="dialog" aria-modal="true" aria-label="Unlock Chilli Staff">
      <header className="art lockart"><LeafArt compact /><Wave /></header>
      <main className="body lockbody">
        <h1>Enter MPIN</h1>
        <p className="sub">Unlock Chilli Staff to continue.</p>
        <PinDots filled={pin.length} slots={len} error={shake} />
        <p className={`lockmsg${msg ? " err" : ""}`} role="status" aria-live="polite">
          {waitMs > 0 ? `Too many wrong tries. Try again in ${Math.ceil(waitMs / 1000)} s.` : msg ?? (busy ? "Checking…" : " ")}
        </p>
        <Keypad value={pin} max={len} onChange={(v) => void onChange(v)} disabled={busy || waitMs > 0}
          extra={st.biometric && bio && <button type="button" className="key key-bio" aria-label={`Unlock with ${bio.label}`} onClick={() => void tryBio()}>
            {bio.face
              ? <svg viewBox="0 0 24 24" aria-hidden><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M9 9v1M15 9v1M12 9v4h-1M9.5 15.5c1.4 1 3.6 1 5 0" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden><path d="M12 11v4M8.5 8.5a5 5 0 0 1 8.5 3.5v2M7 12a5 5 0 0 1 .3-1.7M7 15.5V12M10 19c.6-1 1-2.3 1-4M14 19.5c.6-1.4 1-3 1-4.5v-3a3 3 0 0 0-5.5-1.6M5 9a8 8 0 0 1 14 2" /></svg>}
          </button>} />
        <div className="locklinks">
          <button type="button" className="forgot" onClick={() => void passwordInstead()}>Use password instead</button>
          <button type="button" className="forgot" onClick={() => void passwordInstead()}>Forgot MPIN?</button>
        </div>
      </main>
    </div>
  );
}
