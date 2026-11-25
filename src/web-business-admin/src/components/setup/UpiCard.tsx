"use client";

import { useEffect, useState } from "react";
import { Button, Input, Notice } from "@chilli/ui";
import { Card, CardHeader } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { extras } from "@/lib/extras";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";

export const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;

/** UPI id (name@bank) for customer payments: owner only (settings.owner). Hidden on servers without the route. */
export function UpiCard() {
  const { can, ready } = useCan();
  const owner = ready && can("settings.owner");
  const toast = useNotify();
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (owner) extras.upi().then((r) => { setValue(r.upi_vpa ?? ""); setSaved(r.upi_vpa ?? ""); }).catch(() => setValue(null)); }, [owner]);
  if (!owner || value === null) return null;
  async function save() {
    const v = value!.trim();
    if (v && !UPI_RE.test(v)) { setErr("A UPI id looks like name@bank, for example chillidhaba@okicici"); return; }
    setBusy(true); setErr(null);
    try { const r = await extras.saveUpi(v || null); setSaved(r.upi_vpa ?? ""); setValue(r.upi_vpa ?? ""); toast.success(v ? "UPI id saved" : "UPI id removed"); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not save the UPI id"); } finally { setBusy(false); }
  }
  return (
    <Card id="upi">
      <CardHeader title="UPI payments" description="Your UPI id (name@bank). Customers pay to it when you take UPI." />
      <div className="space-y-3">
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="UPI id" placeholder="chillidhaba@okicici" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button variant="primary" loading={busy} disabled={value.trim() === saved} onClick={() => void save()}>Save UPI id</Button>
      </div>
    </Card>
  );
}
