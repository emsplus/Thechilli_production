"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, PasswordInput, Section } from "@chilli/ui";
import { Card, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDate } from "@/lib/datetime";
import { cleanPin, pinProblem, retryAfterText, type PinStatus } from "@/lib/devices";

const em = (e: unknown, fb: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "No connection. Try again." : fb);

/**
 * My account > Counter PIN: set, change or remove my own 4-6 digit PIN for the shared counter tablets. Needs the current
 * password every time (so a PIN seen over a shoulder cannot be used to change it). The PIN is never shown back.
 */
export function MyPinCard() {
  const confirm = useConfirm();
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.myPin()); setError(null); } catch (e) { setError(em(e, "Could not load your PIN status")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function remove() {
    if (!(await confirm({ title: "Remove your PIN?", description: "You will not be able to sign in on counter tablets until you set a new one. Open counter sessions end.", confirmLabel: "Remove PIN", tone: "danger" }))) return;
    setBusy(true);
    try { await api.clearMyPin(); toast.success("PIN removed"); await load(); }
    catch (e) { toast.error(em(e, "Could not remove the PIN")); } finally { setBusy(false); }
  }

  return (
    <Section title="Counter PIN" description="A 4 to 6 digit PIN to sign in quickly on the shared counter tablet. It works only on registered counter devices." data-testid="my-pin">
      {error && <div className="mb-3"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
      {!status && !error ? <div role="status" aria-label="Loading PIN status"><Skeleton className="h-16 rounded-xl" /></div> : status && (
        <Card className="flex flex-wrap items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted"><KeyRound aria-hidden className="size-5" /></span>
          <div className="min-w-0 flex-1 basis-48" data-testid="my-pin-status">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-fg">{status.is_set ? "PIN is set" : "No PIN yet"}
              {status.is_set && status.set_by_manager && <Badge tone="warning">Set by a manager</Badge>}</p>
            <p className="text-xs text-fg-muted">{status.is_set
              ? `${status.set_at ? `Set on ${formatDate(status.set_at)}. ` : ""}${status.set_by_manager ? "Change it to one only you know." : "Change it any time."}`
              : "Set one to sign in on the counter tablet."}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setOpen(true)}>{status.is_set ? "Change PIN" : "Set PIN"}</Button>
            {status.is_set && <Button variant="danger-soft" loading={busy} onClick={() => void remove()}>Remove</Button>}
          </div>
        </Card>
      )}
      <SetPinDialog open={open} change={!!status?.is_set} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void load(); }} />
    </Section>
  );
}

function SetPinDialog({ open, change, onClose, onDone }: { open: boolean; change: boolean; onClose: () => void; onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [pw, setPw] = useState("");
  const [errs, setErrs] = useState<{ pin?: string; again?: string; pw?: string; top?: string }>({});
  const [busy, setBusy] = useState(false);
  // Nothing typed survives a close: the PIN and the password are cleared every time the dialog opens or closes.
  useEffect(() => { void Promise.resolve().then(() => { setPin(""); setAgain(""); setPw(""); setErrs({}); }); }, [open]);

  async function save() {
    const e: typeof errs = {};
    const p = pinProblem(pin);
    if (p) e.pin = p;
    else if (again !== pin) e.again = "The two PINs are different";
    if (!pw) e.pw = "Enter your current password";
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try { await api.setMyPin(pin, pw); toast.success(change ? "PIN changed" : "PIN set"); onDone(); }
    catch (err) {
      const x = err instanceof ApiError ? err : null;
      if (x?.status === 403 && /password/i.test(x.message) && !/after signing in/i.test(x.message)) setErrs({ pw: "Current password is incorrect" });
      else if (x?.status === 422) setErrs({ pin: x.message || "Use 4 to 6 digits" });
      else if (x?.status === 429) setErrs({ top: `Too many wrong passwords. ${retryAfterText((x as ApiError & { retryAfter?: number }).retryAfter)}` });
      else setErrs({ top: em(err, "Could not save the PIN") });
      setPw("");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={change ? "Change your PIN" : "Set your PIN"}
      description="4 to 6 digits. Avoid 1111 or 1234, and do not use your phone or card PIN."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" type="submit" form="my-pin-form" loading={busy}>{change ? "Change PIN" : "Set PIN"}</Button></>}>
      <form id="my-pin-form" noValidate className="space-y-4 py-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {errs.top && <Notice tone="danger">{errs.top}</Notice>}
        {/* type=password keeps the digits hidden; inputMode gives the number pad on phones. Never prefilled or echoed. */}
        <Input label={change ? "New PIN" : "PIN"} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} error={errs.pin} onChange={(e) => setPin(cleanPin(e.target.value))} />
        <Input label="PIN again" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={again} error={errs.again} onChange={(e) => setAgain(cleanPin(e.target.value))} />
        <PasswordInput label="Current password" autoComplete="current-password" value={pw} error={errs.pw} hint="Needed to set or change a PIN." onChange={(e) => setPw(e.target.value)} />
      </form>
    </Dialog>
  );
}
