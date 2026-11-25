"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LogOut } from "lucide-react";
import { Button, Notice, Section, Select } from "@chilli/ui";
import { toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { canRevokeDevice, canSignOutUser, deviceTitle, filterByPerson, peopleOf, sortDevices, type SignedInDevice, type Viewer } from "@/lib/devices";
import { DeviceRows } from "./DeviceRows";

const em = (e: unknown, fb: string) => (e instanceof ApiError && e.status !== 0 ? e.message : e instanceof ApiError ? "No connection. Try again." : fb);

/** devices.manage: everyone's signed-in devices, filter by person, revoke one, or sign a person out everywhere (lost phone). */
export function AllDevices({ me }: { me: Viewer }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<SignedInDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.devices({ all: true })); setError(null); } catch (e) { setError(em(e, "Could not load the devices")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const people = useMemo(() => peopleOf(rows ?? []), [rows]);
  const list = useMemo(() => sortDevices(filterByPerson(rows ?? [], person)), [rows, person]);
  const who = people.find((p) => p.id === person) ?? null;
  const activeCount = list.filter((d) => d.active).length;

  async function revoke(d: SignedInDevice) {
    const title = deviceTitle(d);
    if (!(await confirm({ title: `Revoke ${title}?`, description: `${d.user_name ?? "This person"} is signed out on it at once. A screen open there may keep working for up to 30 minutes.`, confirmLabel: "Revoke", tone: "danger" }))) return;
    setBusy(d.id);
    try { await api.revokeDevice(d.id); toast.success(`${title} signed out`); await load(); }
    catch (e) { toast.error(em(e, "Could not revoke the device")); } finally { setBusy(null); }
  }

  async function signOutPerson() {
    if (!who) return;
    if (!(await confirm({ title: `Sign ${who.name} out everywhere?`, description: "Every phone and browser of theirs is signed out and their counter PIN sessions end. Use it for a lost or stolen phone.", confirmLabel: "Sign out everywhere", tone: "danger" }))) return;
    setBusy("person");
    try { const r = await api.signOutUser(who.id); toast.success(`${who.name}: signed out of ${r.devices_signed_out} device${r.devices_signed_out === 1 ? "" : "s"}`); await load(); }
    catch (e) { toast.error(em(e, "Could not sign them out")); } finally { setBusy(null); }
  }

  return (
    <Section title="All staff devices" description="Every phone and browser signed in to this restaurant." data-testid="all-devices">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <Select label="Person" value={person} onChange={(e) => setPerson(e.target.value)} disabled={!rows}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` (${p.role})` : ""}</option>)}
          </Select>
        </div>
        {who && canSignOutUser(me, who) && (
          <Button variant="danger-soft" iconStart={<LogOut />} loading={busy === "person"} disabled={activeCount === 0} onClick={() => void signOutPerson()}>Sign {who.name} out everywhere</Button>
        )}
      </div>
      {error && <div className="mb-3"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
      <DeviceRows rows={list} loading={!rows && !error} showPerson canRevoke={(d) => !d.current && canRevokeDevice(me, d)} onRevoke={(d) => void revoke(d)} busyId={busy} testId="all-device-list" />
    </Section>
  );
}
