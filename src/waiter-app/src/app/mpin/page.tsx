"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Keypad, PinDots } from "@/components/Keypad";
import { LeafArt, Wave } from "@/components/Scenery";
import { auth } from "@/lib/api";
import { homeRouteNow } from "@/lib/capsStore";
import { defaultSessionGateway } from "@/lib/session";
import { enableBiometric, setupMpin } from "@/lib/lock/actions";
import { biometricInfo, type BioInfo } from "@/lib/lock/native";
import { PIN_MAX, PIN_MIN, isWeakPin } from "@/lib/lock/policy";
import { prefs } from "@/lib/lock/state";
import { isNative } from "@/lib/native/platform";

type Step = "create" | "confirm" | "bio";

/**
 * "Set a 4-6 digit MPIN", offered right after an email + password sign-in on the phone app (never on the sign-in screen
 * itself). Skippable once; More > Security can set it later. Then Face ID / fingerprint, when the phone has it.
 */
export default function MpinSetup() {
  const r = useRouter();
  const [step, setStep] = useState<Step>("create");
  const [first, setFirst] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState<BioInfo | null>(null);
  const [canSkip] = useState(() => !prefs.skipped());
  const [from, setFrom] = useState<"login" | "security">("login");

  useEffect(() => {
    void auth.hydrate().then(() => {
      if (new URLSearchParams(location.search).get("from") === "security") setFrom("security"); if (!auth.token || !isNative()) r.replace(auth.token ? homeRouteNow() : "/login"); });
    void biometricInfo().then((b) => setBio(b.available ? b : null));
  }, [r]);

  const next = () => r.replace(from === "security" ? "/more/security" : defaultSessionGateway.currentShift() ? homeRouteNow() : "/outlet");
  const skip = () => { prefs.markSkipped(); next(); };

  async function save() {
    if (pin !== first) { setErr("The two MPINs do not match. Start again."); setPin(""); setFirst(""); setStep("create"); return; }
    setBusy(true); setErr(null);
    try {
      await setupMpin(pin);
      if (bio) { setStep("bio"); setBusy(false); return; }
      next();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the MPIN"); setBusy(false);
    }
  }
  function cont() {
    if (step === "create") {
      if (isWeakPin(pin)) { setErr("Too easy to guess. Avoid 1111 or 1234."); return; }
      setFirst(pin); setPin(""); setErr(null); setStep("confirm"); return;
    }
    void save();
  }
  async function turnOnBio() {
    setBusy(true); setErr(null);
    const res = await enableBiometric(first);
    setBusy(false);
    if (res.ok) next(); else setErr(`${bio?.label ?? "Fingerprint"} was not turned on. You can try again in More > Security.`);
  }

  if (step === "bio") {
    return (
      <div className="entry grow">
        <header className="art"><LeafArt compact /><Wave /></header>
        <main id="main" className="body grow">
          <h1>Use {bio?.label}?</h1>
          <p className="sub">Unlock with {bio?.label} instead of typing your MPIN. The MPIN always works too.</p>
          <span className="accent" aria-hidden="true" />
          {err && <div className="banner err" role="alert">{err}</div>}
          <div className="spacer" />
          <div className="actions">
            <button className="btn outline pillbtn" onClick={next}>Not now</button>
            <button className="btn primary grad pillbtn" disabled={busy} onClick={() => void turnOnBio()}>Turn on</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="entry grow">
      <header className="art lockart"><LeafArt compact /><Wave /></header>
      <main id="main" className="body lockbody">
        <h1>{step === "create" ? "Set a 4-6 digit MPIN" : "Enter it again"}</h1>
        <p className="sub">{step === "create" ? "Next time, open the app with this MPIN instead of your email and password." : "Type the same MPIN to confirm."}</p>
        <PinDots filled={pin.length} slots={step === "confirm" ? first.length : PIN_MAX} />
        <p className={`lockmsg${err ? " err" : ""}`} role="status" aria-live="polite">{err ?? (step === "create" ? `${PIN_MIN} to ${PIN_MAX} digits` : " ")}</p>
        <Keypad value={pin} max={step === "confirm" ? first.length : PIN_MAX} onChange={(v) => { setPin(v); setErr(null); }} disabled={busy} />
        <div className="actions lockactions">
          {from === "security"
            ? <button className="btn outline pillbtn" onClick={next}>Cancel</button>
            : canSkip ? <button className="btn outline pillbtn" onClick={skip}>Skip for now</button> : null}
          <button className="btn primary grad pillbtn" disabled={busy || (step === "create" ? pin.length < PIN_MIN : pin.length !== first.length)} onClick={cont}>
            {busy ? "Saving…" : step === "create" ? "Continue" : "Save MPIN"}
          </button>
        </div>
      </main>
    </div>
  );
}
