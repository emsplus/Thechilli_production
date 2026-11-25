"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Dialog, Input, Notice, PasswordInput } from "@chilli/ui";
import { api, StepUpError } from "@/lib/api";
import { cleanPin, PIN_MIN, stepUpFailure } from "@/lib/devices";
import { registerStepUpPrompt } from "@/lib/stepUpPrompt";

/**
 * The "re-enter your PIN" dialog behind withStepUp() (src/lib/stepUpPrompt.ts). Mounted once in Providers. The PIN (or,
 * for someone without a PIN, the password) goes to POST /auth/step-up through the BFF; the 5-minute token it returns stays
 * in memory (api.ts) and nothing typed here is kept after the dialog closes.
 */
export function StepUpHost() {
  const [what, setWhat] = useState<string | null>(null);
  const [method, setMethod] = useState<"pin" | "password">("pin");
  const [pin, setPin] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (ok: boolean) => void } | null>(null);

  useEffect(() => registerStepUpPrompt((w) => {
    if (pending.current) return pending.current.promise; // a second request while open shares the same answer
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    pending.current = { promise, resolve };
    setWhat(w); setMethod("pin"); setPin(""); setPw(""); setErr(null);
    return promise;
  }), []);

  const finish = (ok: boolean) => {
    pending.current?.resolve(ok);
    pending.current = null;
    setWhat(null); setPin(""); setPw(""); setErr(null);
  };

  async function submit() {
    if (method === "pin" && pin.length < PIN_MIN) { setErr("Enter your 4 to 6 digit PIN."); return; }
    if (method === "password" && !pw) { setErr("Enter your password."); return; }
    setBusy(true); setErr(null);
    try { await api.stepUp(method === "pin" ? { pin } : { password: pw }); finish(true); }
    catch (e) {
      const x = e instanceof StepUpError ? e : null;
      setErr(x ? stepUpFailure(x.status, { attemptsLeft: x.attemptsLeft, retryAfter: x.retryAfter, message: x.message, method }) : "Could not check it. Try again.");
      setPin(""); setPw("");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={what !== null} onOpenChange={(o) => { if (!o && !busy) finish(false); }} title="Confirm it is you"
      description={what ? `Enter your ${method === "pin" ? "counter PIN" : "password"} to ${what}.` : undefined}
      footer={<><Button variant="secondary" onClick={() => finish(false)} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="step-up-form" loading={busy} iconStart={<ShieldCheck />}>Confirm</Button></>}>
      <form id="step-up-form" noValidate className="space-y-4 py-2" data-testid="step-up-dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {err && <Notice tone="danger">{err}</Notice>}
        {method === "pin"
          ? <Input label="PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} autoFocus value={pin} onChange={(e) => setPin(cleanPin(e.target.value))} />
          : <PasswordInput label="Password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />}
        <Button variant="ghost" size="sm" onClick={() => { setMethod(method === "pin" ? "password" : "pin"); setErr(null); setPin(""); setPw(""); }}>
          {method === "pin" ? "No PIN? Use my password" : "Use my PIN instead"}
        </Button>
      </form>
    </Dialog>
  );
}
