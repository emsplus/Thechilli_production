"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { BootScreen } from "@/components/BootScreen";
import { Keypad, PinDots } from "@/components/Keypad";
import { LeafArt, Wave } from "@/components/Scenery";
import { auth } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";
import { loadRoster, removeCounter, setupCounter, signInWithPin } from "@/lib/counter/actions";
import { lockedMessage, wrongPinMessage, type CounterStaff, type Roster, type RosterResult } from "@/lib/counter/core";
import { counterState } from "@/lib/counter/state";
import { isNative } from "@/lib/native/platform";
import { statusBarForApp } from "@/lib/native/statusBar";

const PIN_MIN = 4, PIN_MAX = 6;
const rosterError = (r: Exclude<RosterResult, { ok: true }> | { ok: false; reason: "invalid" }): string =>
  r.reason === "invalid" ? "That is not a counter device code. It starts with cdt_ (business admin > Devices)."
    : r.reason === "removed" ? "This tablet was removed or the code is wrong. Ask a manager for a new device code."
      : r.reason === "offline" ? "Cannot reach the server. Check Wi-Fi and try again."
        : r.reason === "unsupported" ? "This server does not support counter tablets yet."
          : r.detail ?? "Something went wrong. Try again.";

/**
 * Shared counter tablet: set-up (paste the device code once), then "Tap your name" and a staff PIN. Each PIN session is
 * that person's own (orders are recorded as them), ends after 15 idle minutes, on "Switch user" or on restart.
 * Native app only (the code is kept in Keychain / Keystore).
 */
export default function CounterPage() {
  const r = useRouter();
  const st = useSyncExternalStore(counterState.subscribe, counterState.get, counterState.get);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<CounterStaff | null>(null);
  const [pin, setPin] = useState("");

  useEffect(() => { statusBarForApp(); void auth.hydrate(); }, []);
  useEffect(() => { if (st.ready && !isNative()) r.replace("/login"); }, [st.ready, r]);

  const refresh = useCallback(() => loadRoster().then((res) => {
    if (res.ok) { setRoster(res.roster); setErr(null); } else setErr(rosterError(res));
  }), []);
  useEffect(() => { if (st.deviceToken && !st.session) void refresh(); }, [st.deviceToken, st.session, refresh]);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const res = await setupCounter(code);
    setBusy(false);
    if (res.ok) { setRoster(res.roster); setCode(""); } else setErr(rosterError(res));
  }

  async function submitPin() {
    if (!who || pin.length < PIN_MIN || busy) return;
    setBusy(true); setErr(null);
    const res = await signInWithPin(who.id, pin, roster?.device.outlet_name);
    setBusy(false); setPin("");
    // Go to the tables only now: signInWithPin has opened the shift, so the shell's shift guard does not bounce to the outlet screen
    // (it reads the shift once per auth change and would stay on the splash).
    if (res.ok) { r.replace(homeRouteNow()); return; }
    if (res.reason === "wrong") setErr(wrongPinMessage(res.attemptsLeft));
    else if (res.reason === "locked") setErr(lockedMessage(res.retryAfterSec));
    else setErr(rosterError(res));
  }

  async function remove() {
    if (!confirm("Stop using this tablet as a counter device? Staff will need a manager's new device code to use it again.")) return;
    await removeCounter();
    r.replace("/login");
  }

  if (!st.ready || st.session) return <BootScreen />;

  if (!st.deviceToken) {
    return (
      <div className="entry">
        <header className="art"><LeafArt compact /><Wave /></header>
        <main id="main" className="body grow">
          <h1>Counter tablet</h1>
          <p className="sub">One tablet for the whole team: each person taps their name and types their staff PIN.</p>
          <span className="accent" aria-hidden="true" />
          <form onSubmit={connect} noValidate>
            <label className="uf"><span>Device code</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="cdt_…" />
            </label>
            <p className="hint">A manager creates it in business admin &gt; Devices &gt; Add counter tablet. It is shown once.</p>
            {err && <div className="banner err" role="alert">{err}</div>}
            <div className="spacer" />
            <div className="actions">
              <button type="button" className="btn outline pillbtn" onClick={() => r.replace("/login")}>Back</button>
              <button className="btn primary grad pillbtn" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Connect"}</button>
            </div>
          </form>
        </main>
      </div>
    );
  }

  if (who) {
    return (
      <div className="entry grow">
        <header className="art lockart"><LeafArt compact /><Wave /></header>
        <main id="main" className="body lockbody">
          <h1>Hi, {who.name.split(" ")[0]}</h1>
          <p className="sub">Enter your staff PIN.</p>
          <PinDots filled={pin.length} slots={Math.max(PIN_MIN, pin.length)} />
          <p className={`lockmsg${err ? " err" : ""}`} role="status" aria-live="polite">{err ?? (busy ? "Checking…" : " ")}</p>
          <Keypad value={pin} max={PIN_MAX} onChange={(v) => { setPin(v); setErr(null); }} disabled={busy} />
          <div className="actions lockactions">
            <button className="btn outline pillbtn" onClick={() => { setWho(null); setPin(""); setErr(null); }}>Not me</button>
            <button className="btn primary grad pillbtn" disabled={busy || pin.length < PIN_MIN} onClick={() => void submitPin()}>{busy ? "Signing in…" : "Sign in"}</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="entry">
      <header className="art lockart"><LeafArt compact /><Wave /></header>
      <main id="main" className="body grow">
        <h1>Tap your name</h1>
        <p className="sub">{roster ? `${roster.device.name} · ${roster.device.outlet_name}` : "Loading the team…"}</p>
        {st.ended === "idle" && !err && <div className="banner" role="status">Signed out because the tablet was not used for a while.</div>}
        {st.ended === "ended" && !err && <div className="banner" role="status">That session ended. Sign in again with your PIN.</div>}
        {err && <div className="banner err" role="alert">{err} <button className="btn" onClick={() => void refresh()}>Try again</button></div>}
        {roster && !roster.staff.length && <p className="muted">Nobody can sign in here yet. A manager sets staff PINs in business admin &gt; Staff.</p>}
        <div className="roster">
          {roster?.staff.map((s) => (
            <button key={s.id} type="button" className="rostercard" onClick={() => { setWho(s); setErr(null); }}>
              <span className="initials" aria-hidden="true">{s.initials}</span>
              <span className="nm">{s.name}</span>
              <span className="small muted">{s.role}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button type="button" className="forgot" onClick={() => void remove()}>Stop using as counter tablet</button>
      </main>
    </div>
  );
}
