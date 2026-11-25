"use client";

import { useEffect, useState } from "react";
import { LockOpen } from "lucide-react";
import { Button, Dialog, Input, Notice } from "@chilli/ui";
import { toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cleanPin, pinProblem } from "@/lib/devices";

const em = (e: unknown, fb: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "No connection. Try again." : fb);

/**
 * staff.pin.manage: set or reset a staff member's counter PIN, remove it, or unlock it after too many wrong tries.
 * The caller only opens it where canManagePinOf() allows (an owner's PIN only by an owner). Setting or removing a PIN ends
 * their counter sessions and clears lockouts; they are asked to change a manager-set PIN at their next PIN sign-in.
 */
export function StaffPinDialog({ user, onClose }: { user: { id: string; full_name: string } | null; onClose: () => void }) {
  const confirm = useConfirm();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [errs, setErrs] = useState<{ pin?: string; again?: string; top?: string }>({});
  const [busy, setBusy] = useState<null | "set" | "clear" | "unlock">(null);
  const [last, setLast] = useState(user);
  useEffect(() => { void Promise.resolve().then(() => { setPin(""); setAgain(""); setErrs({}); if (user) setLast(user); }); }, [user]);
  const shown = user ?? last;
  const name = shown?.full_name ?? "this person";

  async function set() {
    if (!user) return;
    const p = pinProblem(pin);
    const e = p ? { pin: p } : again !== pin ? { again: "The two PINs are different" } : {};
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy("set");
    try { await api.setUserPin(user.id, pin); toast.success(`New PIN set for ${user.full_name}. Tell them in person; they will be asked to change it.`); onClose(); }
    catch (err) { setErrs(err instanceof ApiError && err.status === 422 ? { pin: err.message } : { top: em(err, "Could not set the PIN") }); }
    finally { setBusy(null); }
  }
  async function clear() {
    if (!user || !(await confirm({ title: `Remove ${user.full_name}'s PIN?`, description: "They cannot sign in on counter tablets until a new PIN is set. Their open counter sessions end.", confirmLabel: "Remove PIN", tone: "danger" }))) return;
    setBusy("clear");
    try { await api.clearUserPin(user.id); toast.success(`PIN removed for ${user.full_name}`); onClose(); }
    catch (err) { setErrs({ top: em(err, "Could not remove the PIN") }); } finally { setBusy(null); }
  }
  async function unlock() {
    if (!user) return;
    setBusy("unlock");
    try { await api.unlockUserPin(user.id); toast.success(`${user.full_name} can try their PIN again`); onClose(); }
    catch (err) { setErrs({ top: em(err, "Could not unlock the PIN") }); } finally { setBusy(null); }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title={`Counter PIN for ${name}`}
      description="Set a new PIN and tell it to them in person. They should change it to one only they know."
      footer={<><Button variant="secondary" onClick={onClose} disabled={!!busy}>Cancel</Button><Button variant="primary" type="submit" form="staff-pin-form" loading={busy === "set"} disabled={!!busy && busy !== "set"}>Set PIN</Button></>}>
      <div className="space-y-4 py-2" data-testid="staff-pin-dialog">
        {errs.top && <Notice tone="danger">{errs.top}</Notice>}
        <form id="staff-pin-form" noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); void set(); }}>
          <Input label="New PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} error={errs.pin} hint="4 to 6 digits, not 1111 or 1234." onChange={(e) => setPin(cleanPin(e.target.value))} />
          <Input label="New PIN again" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={again} error={errs.again} onChange={(e) => setAgain(cleanPin(e.target.value))} />
        </form>
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-48 text-sm text-fg-muted">Locked out after too many wrong PINs? Unlock lets them try again now.</p>
            <Button variant="secondary" iconStart={<LockOpen />} loading={busy === "unlock"} disabled={!!busy && busy !== "unlock"} onClick={() => void unlock()}>Unlock</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-48 text-sm text-fg-muted">Stop them signing in on counter tablets.</p>
            <Button variant="danger-soft" loading={busy === "clear"} disabled={!!busy && busy !== "clear"} onClick={() => void clear()}>Remove PIN</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
