"use client";
import { useState } from "react";
import { Badge, Button, Card, Input, Select, Sheet, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, FormError, SubNav, NoAccess } from "@/components/ui";
import { earningsNav } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtMoney, fmtPct } from "@/lib/format";
import type { Calc, Recipient } from "@/lib/api/types";

export default function RulesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useQuery("rules", () => api.commissions.rules());
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", recipient: "lead_owner" as Recipient, calc: "percent_bps" as Calc, flat: "", pct: "", cap: "" });
  const create = useAction();
  const toggle = useAction();
  if (!can(user?.role, "commission.rules")) return <NoAccess role={user?.role} what="Commission rules" />;
  async function save() {
    const r = await create.run(() => api.commissions.createRule({
      name: f.name.trim(), recipient: f.recipient, calc: f.calc,
      ...(f.calc === "flat" ? { flat_amount_minor: Math.round(Number(f.flat) * 100) } : { rate_bps: Math.round(Number(f.pct) * 100) }),
      cap_minor: f.cap ? Math.round(Number(f.cap) * 100) : null,
    }));
    if (r) { toast.show("Rule created", "success"); setOpen(false); q.reload(); }
  }
  return (
    <div className="stack">
      <PageHeader title="Commission rules" description="Applied when a business is provisioned. Amounts of existing rules cannot be edited." actions={<><Button variant="primary" onClick={() => setOpen(true)}>+ Rule</Button></>} />
      <SubNav items={earningsNav(user?.role)} />
      <FormError error={toggle.error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No rules", description: "Without a rule, provisioning creates no commission." }}>
        {(rows) => (
          <Card><ul className="list">{rows.map((r) => (
            <li key={r.id}>
              <span className="grow"><span className="title">{r.name}</span> {!r.is_active && <Badge tone="neutral">off</Badge>}<br />
                <span className="small muted">{r.recipient.replace("_", " ")} · {r.calc === "flat" ? fmtMoney(r.flat_amount_minor, r.currency) : fmtPct(r.rate_bps)}{r.cap_minor ? ` · cap ${fmtMoney(r.cap_minor, r.currency)}` : ""}</span></span>
              <Button size="sm" variant="ghost" disabled={toggle.busy} onClick={async () => { if (await toggle.run(() => api.commissions.updateRule(r.id, { is_active: !r.is_active }))) q.reload(); }}>{r.is_active ? "Turn off" : "Turn on"}</Button>
            </li>))}</ul></Card>
        )}
      </AsyncView>
      <Sheet open={open} onOpenChange={setOpen} title="New commission rule"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.busy} disabled={!f.name.trim() || !(f.calc === "flat" ? f.flat : f.pct)} onClick={save}>Create</Button></>}>
        <div className="stack-sm">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Select label="Paid to" value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value as Recipient })}><option value="lead_owner">Lead owner</option><option value="application_agent">Onboarding agent</option><option value="referrer">Referrer</option></Select>
          <Select label="Calculation" value={f.calc} onChange={(e) => setF({ ...f, calc: e.target.value as Calc })}><option value="percent_bps">Percent of contract</option><option value="flat">Flat amount</option></Select>
          {f.calc === "flat" ? <Input label="Amount" type="number" inputMode="decimal" min={0} value={f.flat} onChange={(e) => setF({ ...f, flat: e.target.value })} /> : <Input label="Rate (%)" type="number" inputMode="decimal" min={0} max={100} value={f.pct} onChange={(e) => setF({ ...f, pct: e.target.value })} />}
          <Input label="Cap (optional)" type="number" inputMode="decimal" min={0} value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} />
          <FormError error={create.error} />
        </div>
      </Sheet>
    </div>
  );
}
