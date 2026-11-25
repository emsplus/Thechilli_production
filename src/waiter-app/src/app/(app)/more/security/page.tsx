"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppShell } from "@/components/AppShell";
import { Keypad, PinDots } from "@/components/Keypad";
import { wrongMessage } from "@/components/LockScreen";
import { changeMpin, disableBiometric, verifyMpin, enableBiometric, lockNow, removeMpin, signOutPhone } from "@/lib/lock/actions";
import { biometricInfo, type BioInfo } from "@/lib/lock/native";
import { AUTO_LOCK_CHOICES, PIN_MAX, PIN_MIN, autoLockLabel, isWeakPin, type AutoLock } from "@/lib/lock/policy";
import type { PinResult } from "@/lib/lock/vault";
import { lockState, prefs } from "@/lib/lock/state";
import { useQueue } from "@/lib/sync";
import { useDialogFocus } from "@/lib/dialogFocus";
import { isShiftRef } from "@/lib/orderEntries";

type Ask = { title: string; len: number | null; run: (pin: string) => Promise<string | null> };

/** MPIN entry in a bottom sheet: fixed length (known MPIN) checks on the last digit, free length (new MPIN) has a Continue button. */
function PinSheet({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = ask.len ?? PIN_MAX;
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  async function go(v: string) {
    setBusy(true);
    const e = await ask.run(v);
    setBusy(false); setPin("");
    setErr(e);
  }
  return (
    <div className="sheet" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={ask.title} tabIndex={-1} ref={dialog} onClick={(e) => e.stopPropagation()} className="pinsheet">
        <div className="grabber" aria-hidden />
        <h2 className="sheet-title">{ask.title}</h2>
        <PinDots filled={pin.length} slots={max} />
        <p className={`lockmsg${err ? " err" : ""}`} role="status" aria-live="polite">{err ?? (ask.len ? " " : `${PIN_MIN} to ${PIN_MAX} digits`)}</p>
        <Keypad value={pin} max={max} disabled={busy} onChange={(v) => { setPin(v); setErr(null); if (ask.len && v.length === ask.len) void go(v); }} />
        <div className="actions lockactions">
          <button className="btn outline pillbtn" onClick={onClose}>Cancel</button>
          {!ask.len && <button className="btn primary grad pillbtn" disabled={busy || pin.length < PIN_MIN} onClick={() => void go(pin)}>Continue</button>}
        </div>
      </div>
    </div>
  );
}

const failText = (r: PinResult): string | null => {
  if (r.ok) return null;
  if (r.reason === "wrong") return wrongMessage(r.remaining, r.waitMs);
  if (r.reason === "wait") return `Too many wrong tries. Try again in ${Math.ceil(r.waitMs / 1000)} s.`;
  return "Signed out of this phone.";
};

/** More > Security: MPIN, Face ID / fingerprint, auto-lock time, sign out of this phone. */
export default function Security() {
  const router = useRouter();
  const st = useSyncExternalStore(lockState.subscribe, lockState.get, lockState.get);
  const ops = useQueue();
  const [bio, setBio] = useState<BioInfo | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [auto, setAuto] = useState<AutoLock>(() => prefs.autoLock());
  useEffect(() => { void biometricInfo().then((b) => setBio(b.available ? b : null)); }, []);
  const unsent = ops.filter((o) => o.status !== "synced" && !isShiftRef(o.order_ref)).length;
  const gone = (r: PinResult) => { if (!r.ok && r.reason === "wiped") { setAsk(null); router.replace("/login"); } };

  function change() {
    setNote(null);
    setAsk({ title: "Current MPIN", len: st.pinLength, run: async (cur) => {
      const ok = await verifyMpin(cur);
      gone(ok);
      if (!ok.ok) return failText(ok);
      setAsk({ title: "New MPIN", len: null, run: async (nw) => {
        if (isWeakPin(nw)) return "Too easy to guess. Avoid 1111 or 1234.";
        setAsk({ title: "New MPIN again", len: nw.length, run: async (again) => {
          if (again !== nw) return "The two MPINs do not match. Try again.";
          const r = await changeMpin(cur, nw);
          gone(r);
          if (r.ok) { setAsk(null); setNote("MPIN changed."); return null; }
          return failText(r);
        } });
        return null;
      } });
      return null;
    } });
  }
  function bioOn() {
    setNote(null);
    setAsk({ title: "Enter your MPIN", len: st.pinLength, run: async (pin) => {
      const r = await enableBiometric(pin);
      if ("reason" in r && r.reason === "wiped") { gone(r as PinResult); return null; }
      if (r.ok) { setAsk(null); setNote(`${bio?.label ?? "Fingerprint"} unlock is on.`); return null; }
      if (r.reason === "cancelled" || r.reason === "unavailable") { setAsk(null); setNote(`${bio?.label ?? "Fingerprint"} was not turned on.`); return null; }
      return failText(r as PinResult);
    } });
  }
  function mpinOff() {
    setNote(null);
    setAsk({ title: "Enter your MPIN to turn it off", len: st.pinLength, run: async (pin) => {
      const r = await removeMpin(pin);
      gone(r);
      if (r.ok) { setAsk(null); setNote("MPIN is off. The app opens without it."); return null; }
      return failText(r);
    } });
  }
  async function signOut() {
    const warn = unsent ? `${unsent} order${unsent === 1 ? " has" : "s have"} not reached the server yet. They stay on this phone and send after the next sign-in.\n\n` : "";
    if (!confirm(`${warn}Sign out of this phone? The MPIN, ${bio?.label ?? "fingerprint"} unlock and saved sign-in are removed.`)) return;
    await signOutPhone();
    router.replace("/login");
  }

  return (
    <AppShell title="Security">
      <Link className="backlink" href="/more">‹ More</Link>
      {note && <div className="banner ok" role="status">{note}</div>}
      {!st.available ? (
        <div className="card"><strong>MPIN lock</strong><p className="small muted">Available in the Chilli Staff phone app.</p></div>
      ) : !st.enabled ? (
        <div className="card">
          <strong>MPIN lock is off</strong>
          <p className="small muted">Set a 4-6 digit MPIN so you do not type your email and password every time.</p>
          <Link className="btn primary block" href="/mpin?from=security">Set MPIN</Link>
        </div>
      ) : (
        <>
          <div className="card row between">
            <div><strong>MPIN lock is on</strong><div className="small muted">{st.pinLength}-digit MPIN</div></div>
            <button className="btn" onClick={change}>Change MPIN</button>
          </div>
          {bio && (
            <div className="card row between">
              <div className="grow"><strong>{bio.label}</strong><div className="small muted">Unlock without typing the MPIN</div></div>
              <button className="switch" role="switch" aria-checked={st.biometric} aria-label={`${bio.label} unlock`} onClick={() => (st.biometric ? void disableBiometric() : bioOn())}><i /></button>
            </div>
          )}
          <h2 className="sec">Lock the app</h2>
          <div className="radiolist" role="radiogroup" aria-label="Auto-lock">
            {AUTO_LOCK_CHOICES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={auto === m} className="radiorow" onClick={() => { prefs.setAutoLock(m); setAuto(m); }}>
                <span>{autoLockLabel(m)}{m === 5 ? " (default)" : ""}</span><i aria-hidden />
              </button>
            ))}
          </div>
          <p className="small muted">Time in the background before the MPIN is asked again. The app always asks after a restart.</p>
          <button className="btn block" style={{ marginBottom: 10 }} onClick={lockNow}>Lock now</button>
          <button className="btn block" style={{ marginBottom: 10 }} onClick={mpinOff}>Turn off MPIN</button>
        </>
      )}
      <h2 className="sec">This phone</h2>
      <button className="btn danger block" onClick={() => void signOut()}>Sign out of this phone</button>
      <p className="small muted">Ends this phone&apos;s session and removes the MPIN and saved sign-in.</p>
      {ask && <PinSheet key={ask.title} ask={ask} onClose={() => setAsk(null)} />}
    </AppShell>
  );
}
