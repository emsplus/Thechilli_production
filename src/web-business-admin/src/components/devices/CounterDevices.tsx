"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Plus, TabletSmartphone, TriangleAlert } from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, Section, Select } from "@chilli/ui";
import { Card, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { counterActive, lastSeenText, type CounterDevice, type CounterDeviceCreated } from "@/lib/devices";
import { qrMatrix, qrPath } from "@/lib/qr";
import type { Outlet } from "@/lib/types";

const em = (e: unknown, fb: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "No connection. Try again." : fb);

/**
 * devices.manage: shared counter tablets. Registering one returns its credential ONCE (only its hash is kept): it is shown
 * here as text and a QR code to type or scan into the tablet, then forgotten. Revoking ends every PIN session on it at once.
 */
export function CounterDevices({ readOnly = false }: { readOnly?: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<CounterDevice[] | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<(CounterDeviceCreated & { outlet_name: string | null }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.counterDevices()); setError(null); } catch (e) { setError(em(e, "Could not load the counter devices")); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
    api.outlets().then((o) => setOutlets(o.filter((x) => x.is_active)), () => setOutlets([]));
  }, [load]);
  const list = useMemo(() => [...(rows ?? [])].sort((a, b) => Number(counterActive(b)) - Number(counterActive(a)) || a.name.localeCompare(b.name)), [rows]);

  async function revoke(c: CounterDevice) {
    if (!(await confirm({ title: `Revoke ${c.name}?`, description: `The tablet stops working at once and ${c.active_sessions ? `${c.active_sessions} open PIN session${c.active_sessions === 1 ? "" : "s"} end` : "nobody can sign in on it"}. Use it for a lost or stolen tablet. To use it again, register it again.`, confirmLabel: "Revoke tablet", tone: "danger" }))) return;
    setBusy(c.id);
    try { await api.revokeCounterDevice(c.id); toast.success(`${c.name} revoked`); await load(); }
    catch (e) { toast.error(em(e, "Could not revoke the tablet")); } finally { setBusy(null); }
  }

  return (
    <Section title="Counter devices" description="Shared tablets at the counter. Staff sign in on them with their PIN." data-testid="counter-devices"
      actions={<Button variant="primary" iconStart={<Plus />} disabled={readOnly || !rows} onClick={() => setAdding(true)}>Register a counter device</Button>}>
      {error && <div className="mb-3"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
      {!rows && !error ? <div role="status" aria-label="Loading counter devices" className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
        : list.length === 0 && !error ? <Card><p className="py-4 text-center text-sm text-fg-muted"><TabletSmartphone aria-hidden className="mx-auto mb-2 size-6" />No counter devices yet. Register the tablet at your counter to let staff sign in with a PIN.</p></Card>
        : list.length > 0 && (
          <Card padded={false}>
            <ul className="divide-y divide-border" data-testid="counter-list">
              {list.map((c) => {
                const on = counterActive(c);
                return (
                  <li key={c.id} data-testid="counter-row" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted"><TabletSmartphone aria-hidden className="size-5" /></span>
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-fg"><span className="min-w-0 break-words">{c.name}</span>
                        {on ? (c.active_sessions > 0 && <Badge tone="success">{c.active_sessions} signed in</Badge>) : <Badge tone="neutral">Revoked</Badge>}</p>
                      <p className="text-xs text-fg-muted">{c.outlet_name ?? "Outlet"} · Last seen {lastSeenText(c.last_seen_at).toLowerCase()}{c.last_ip ? <> · IP <span className="tnum">{c.last_ip}</span></> : null}</p>
                    </div>
                    {on && <Button size="sm" variant="danger-soft" loading={busy === c.id} disabled={readOnly} aria-label={`Revoke ${c.name}`} onClick={() => void revoke(c)}>Revoke</Button>}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      <RegisterDialog open={adding} outlets={outlets} onClose={() => setAdding(false)}
        onCreated={(c) => { setAdding(false); setCreated({ ...c, outlet_name: outlets.find((o) => o.id === c.outlet_id)?.name ?? null }); void load(); }} />
      <TokenOnceDialog device={created} onClose={() => setCreated(null)} />
    </Section>
  );
}

function RegisterDialog({ open, outlets, onClose, onCreated }: { open: boolean; outlets: Outlet[]; onClose: () => void; onCreated: (c: CounterDeviceCreated) => void }) {
  const [name, setName] = useState("");
  const [outlet, setOutlet] = useState("");
  const [err, setErr] = useState<{ name?: string; top?: string }>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) void Promise.resolve().then(() => { setName(""); setErr({}); setOutlet(outlets.find((o) => o.is_default)?.id ?? outlets[0]?.id ?? ""); });
  }, [open, outlets]);
  async function save() {
    const n = name.trim();
    if (!n) { setErr({ name: "Give it a name staff will recognise, like Front counter" }); return; }
    if (n.length > 100) { setErr({ name: "Keep it under 100 characters" }); return; }
    setBusy(true); setErr({});
    try { onCreated(await api.createCounterDevice({ name: n, outlet_id: outlet || null })); }
    catch (e) { setErr({ top: em(e, "Could not register the tablet") }); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }} title="Register a counter device" description="Staff will sign in on this tablet with their PIN, at the outlet you choose."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Register</Button></>}>
      <form className="space-y-4 py-2" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {err.top && <Notice tone="danger">{err.top}</Notice>}
        <Input label="Name" value={name} maxLength={100} autoFocus error={err.name} placeholder="Front counter" onChange={(e) => setName(e.target.value)} />
        {outlets.length > 1 && (
          <Select label="Outlet" value={outlet} onChange={(e) => setOutlet(e.target.value)} hint="Staff can only sign in here if they may work at this outlet.">
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}{o.is_default ? " (main)" : ""}</option>)}
          </Select>
        )}
      </form>
    </Dialog>
  );
}

/** The credential, once. Closing needs a deliberate "I have copied it"; nothing is kept after the dialog closes. */
function TokenOnceDialog({ device, onClose }: { device: (CounterDeviceCreated & { outlet_name: string | null }) | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState<typeof device>(null);
  useEffect(() => { if (device) void Promise.resolve().then(() => { setShown(device); setCopied(false); }); }, [device]);
  const d = device ?? shown;
  const matrix = useMemo(() => { try { return d ? qrMatrix(d.device_token) : null; } catch { return null; } }, [d]);
  const close = () => { setShown(null); onClose(); };
  async function copy() {
    if (!d) return;
    try { await navigator.clipboard.writeText(d.device_token); setCopied(true); toast.success("Code copied"); }
    catch { toast.error("Could not copy. Select the code and copy it by hand."); }
  }
  return (
    <Dialog open={!!device} onOpenChange={(o) => { if (!o) close(); }} title={d ? `${d.name} is registered` : "Counter device registered"}
      description="Enter this code on the tablet when it asks for the counter device code, or scan the QR code."
      footer={<Button variant="primary" onClick={close}>{copied ? "Done" : "I have saved the code"}</Button>}>
      {d && (
        <div className="space-y-4 py-2" data-testid="counter-token">
          <Notice tone="warning" title="You will not see this code again">
            Copy it or set up the tablet now. Only a fingerprint of it is stored, so it cannot be shown later. If it is lost, revoke this device and register it again.
          </Notice>
          <div>
            <p id="token-label" className="mb-1 text-sm font-semibold text-fg">Device code{d.outlet_name ? ` for ${d.outlet_name}` : ""}</p>
            <div className="flex items-stretch gap-2">
              <code aria-labelledby="token-label" data-testid="counter-token-value" className="min-w-0 flex-1 select-all break-all rounded-xl border border-border-strong bg-surface-2 px-3 py-2.5 font-mono text-sm text-fg">{d.device_token}</code>
              <Button variant="secondary" className="shrink-0" iconStart={copied ? <Check /> : <Copy />} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
          {matrix && (
            <div className="flex justify-center">
              <svg role="img" aria-label="QR code of the device code" viewBox={`0 0 ${matrix.length + 8} ${matrix.length + 8}`} className="qr-plate size-48 rounded-xl" shapeRendering="crispEdges">
                <path d={qrPath(matrix)} />
              </svg>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs text-fg-muted"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />Anyone with this code can show the staff list of this outlet on a tablet and try PINs. Do not share it in chats or photos.</p>
        </div>
      )}
    </Dialog>
  );
}
