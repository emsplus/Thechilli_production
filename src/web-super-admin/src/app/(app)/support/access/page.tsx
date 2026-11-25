"use client";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select, Table, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { GrantScope, SupportGrant } from "@/lib/api/types";
import { fmtDateTime, minutesLeft, titleCase } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { InlineError, Notice, PageHeader, Pager, ResourceView, StatusBadge, TextArea } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";

const stateOf = (g: SupportGrant) => (g.revoked_at ? "revoked" : Date.parse(g.expires_at) <= Date.now() ? "expired" : "active");

export default function AccessPage() {
  const can = useCan();
  const toast = useToast();
  const { nameOf } = useTenants();
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<SupportGrant | null>(null);
  const res = useResource(() => api.support.grants({ offset }), String(offset));
  const revoke = useAction(async (g: SupportGrant) => { await api.support.revokeGrant(g.id); toast.show("Access revoked", "success"); setRevoking(null); res.reload(); });
  const grant = can("support_access.grant");
  return (
    <>
      <PageHeader title="Access grants" subtitle="Time-boxed permission for one support engineer to look at one business." actions={grant ? <Button variant="primary" onClick={() => setCreating(true)}>New grant</Button> : undefined} />
      <Notice>A grant only records permission and expiry. Super Admin never shows a business&apos;s operational data: the support engineer opens it in the product with a short-lived token, and every grant is audited.</Notice>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No access grants", description: "Grants you create show up here.", actionLabel: grant ? "New grant" : undefined, onAction: () => setCreating(true) }}>
        {(d) => (
          <>
            <Table<SupportGrant> caption="Support access grants" getKey={(g) => g.id} rows={d.items} columns={[
              { key: "t", header: "Business", render: (g) => <TenantLink id={g.tenant_id} name={nameOf(g.tenant_id)} /> },
              { key: "sc", header: "Scope", render: (g) => titleCase(g.scope) }, { key: "r", header: "Reason", render: (g) => g.reason },
              { key: "e", header: "Expires", render: (g) => { const s = stateOf(g); return s === "active" ? `${fmtDateTime(g.expires_at)} (${minutesLeft(g.expires_at)} min left)` : fmtDateTime(g.expires_at); } },
              { key: "s", header: "State", render: (g) => <StatusBadge value={stateOf(g)} /> },
              { key: "a", header: "Action", render: (g) => (grant && stateOf(g) === "active" ? <Button size="sm" variant="danger-soft" onClick={() => setRevoking(g)}>Revoke</Button> : null) },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
      {creating ? <CreateGrant onClose={() => setCreating(false)} onDone={() => { setCreating(false); toast.show("Access granted", "success"); res.reload(); }} /> : null}
      {revoking ? (
        <Dialog open onOpenChange={(o) => !o && setRevoking(null)} title="Revoke access" description={`Access to ${nameOf(revoking.tenant_id)} stops right away.`}
          footer={<><Button onClick={() => setRevoking(null)}>Cancel</Button><Button variant="danger-soft" loading={revoke.busy} onClick={() => void revoke.run(revoking)}>Revoke</Button></>}>
          <InlineError error={revoke.error} />
        </Dialog>
      ) : null}
    </>
  );
}

function CreateGrant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { tenants } = useTenants();
  const staff = useResource(async () => (await api.staff.list()).items.filter((s) => s.role === "support" && s.is_active), "grantees");
  const [tenant, setTenant] = useState("");
  const [staffId, setStaffId] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [scope, setScope] = useState<GrantScope>("read_only");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const mins = Number(minutes);
  const problems = { tenant: !tenant, staff: !staffId && !(staff.data && staff.data.length === 1), minutes: !(mins > 0 && mins <= 240), reason: reason.trim().length < 10 };
  const bad = Object.values(problems).some(Boolean);
  const { run, busy, error } = useAction(async () => { await api.support.createGrant({ tenant, staff_id: staffId || staff.data![0].id, minutes: mins, scope, reason: reason.trim() }); onDone(); });
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (!bad) void run(); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New access grant" description="Grants are for one support engineer and one business, and expire on their own."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="grant-form" loading={busy}>Grant access</Button></>}>
      <form id="grant-form" className="hq-stack" onSubmit={submit} noValidate>
        <Select label="Business" value={tenant} onChange={(e) => setTenant(e.target.value)} error={touched && problems.tenant ? "Choose a business." : undefined}>
          <option value="">Choose…</option>{tenants.filter((t) => t.status !== "closed").map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
        </Select>
        <Select label="Support engineer" value={staffId} onChange={(e) => setStaffId(e.target.value)} error={touched && problems.staff ? "Choose who gets access." : undefined}>
          <option value="">Choose…</option>{staff.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
        </Select>
        <Select label="Scope" value={scope} onChange={(e) => setScope(e.target.value as GrantScope)} hint="Diagnostics adds technical checks; neither can change data.">
          <option value="read_only">Read only</option><option value="diagnostics">Diagnostics</option>
        </Select>
        <Input label="Minutes" type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} hint="Up to 240." error={touched && problems.minutes ? "Enter 1 to 240 minutes." : undefined} />
        <TextArea label="Reason" value={reason} onChange={setReason} hint="At least 10 characters. Recorded in the audit log." error={touched && problems.reason ? "Explain why in at least 10 characters." : undefined} />
        <InlineError error={error as ApiError | undefined} />
      </form>
    </Dialog>
  );
}
