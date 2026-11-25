"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LogOut } from "lucide-react";
import { Button, Checkbox, Dialog, Notice, Section } from "@chilli/ui";
import { toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { canRevokeDevice, deviceTitle, sortDevices, type SignedInDevice, type Viewer } from "@/lib/devices";
import { useSignOut } from "@/lib/useSignOut";
import { DeviceRows } from "./DeviceRows";

const em = (e: unknown, fb: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "No connection. Try again." : fb);

/** "My signed-in devices": every phone / browser signed in as me, with Revoke and "Sign out everywhere". Any signed-in user. */
export function MyDevices({ me, level = 2 }: { me: Viewer; level?: 2 | 3 }) {
  const confirm = useConfirm();
  const signOut = useSignOut();
  const [rows, setRows] = useState<SignedInDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [everywhere, setEverywhere] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await api.devices()); setError(null); } catch (e) { setError(em(e, "Could not load your devices")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const list = useMemo(() => sortDevices(rows ?? []), [rows]);
  const others = list.filter((d) => d.active && !d.current).length;

  async function revoke(d: SignedInDevice) {
    const title = deviceTitle(d);
    const ok = await confirm(d.current
      ? { title: "Sign out of this device?", description: "You will go back to the sign-in page.", confirmLabel: "Sign out", tone: "danger" }
      : { title: `Revoke ${title}?`, description: "It is signed out at once and has to sign in again with the password. A screen that is open there may keep working for up to 30 minutes.", confirmLabel: "Revoke", tone: "danger" });
    if (!ok) return;
    setBusy(d.id);
    try {
      await api.revokeDevice(d.id);
      if (d.current) { await signOut(); return; }
      toast.success(`${title} signed out`);
      await load();
    } catch (e) { toast.error(em(e, "Could not revoke the device")); } finally { setBusy(null); }
  }

  return (
    <Section level={level} title="My signed-in devices" description="Phones and browsers signed in as you. Revoke one you do not recognise or have lost."
      actions={<Button variant="secondary" iconStart={<LogOut />} disabled={!rows} onClick={() => setEverywhere(true)}>Sign out everywhere</Button>}
      data-testid="my-devices">
      {error && <div className="mb-3"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
      <DeviceRows rows={list} loading={!rows && !error} canRevoke={(d) => canRevokeDevice(me, d)} onRevoke={(d) => void revoke(d)} busyId={busy} testId="my-device-list" />
      <SignOutEverywhereDialog open={everywhere} others={others} onClose={() => setEverywhere(false)}
        onDone={async (n, kept) => { toast.success(n === 1 ? "Signed out of 1 device" : `Signed out of ${n} devices`); if (!kept) await signOut(); else await load(); }} />
    </Section>
  );
}

function SignOutEverywhereDialog({ open, others, onClose, onDone }: { open: boolean; others: number; onClose: () => void; onDone: (n: number, kept: boolean) => Promise<void> }) {
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) void Promise.resolve().then(() => { setKeep(true); setErr(null); }); }, [open]);
  async function go() {
    setBusy(true); setErr(null);
    try { const r = await api.signOutEverywhere(keep); onClose(); await onDone(r.devices_signed_out, keep); }
    catch (e) { setErr(em(e, "Could not sign out everywhere")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title="Sign out everywhere?"
      description={keep ? `Every other phone and browser signed in as you is signed out (${others} now). Counter PIN sessions end too.` : "Every phone and browser signed in as you is signed out, this one included. Counter PIN sessions end too."}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger-soft" loading={busy} onClick={() => void go()}>Sign out everywhere</Button></>}>
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        <Checkbox label="Keep me signed in on this device" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
      </div>
    </Dialog>
  );
}
