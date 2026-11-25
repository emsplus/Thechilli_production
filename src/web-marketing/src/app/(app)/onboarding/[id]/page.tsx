"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Dialog, Input, Notice, PageHeader, Select, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { ActivationCard } from "@/components/activation-card";
import { DocumentsCard } from "@/components/documents-card";
import { InviteSheet } from "@/components/invite";
import { AppStatusBadge, AsyncView, FormError } from "@/components/ui";
import { InvitationStatus } from "@/components/invitation-status";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import { CHECKLIST_LABEL, CHECKLIST_ORDER, blockerText } from "@/lib/onboarding";
import type { AppOut } from "@/lib/api/types";

export default function ApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const app = useQuery(`app:${id}`, () => api.onboarding.get(id));
  return <AsyncView q={app} rows={5}>{(a) => <AppView app={a} reload={app.reload} />}</AsyncView>;
}

function AppView({ app, reload }: { app: AppOut; reload: () => void }) {
  const { user } = useAuth();
  const role = user?.role;
  const toast = useToast();
  const { users, name } = usePeople();
  const readiness = useQuery(`ready:${app.id}:${app.status}`, () => api.onboarding.readiness(app.id));
  const invites = useQuery(`app-inv:${app.id}`, async () => (await api.invitations.list({ limit: 200 })).filter((i) => i.application_id === app.id));
  const act = useAction();
  const [confirm, setConfirm] = useState<"provision" | "cancel" | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [agent, setAgent] = useState(app.agent_id ?? "");
  const [contract, setContract] = useState(String(app.contract_value_minor / 100));
  const locked = app.status === "provisioned" || app.status === "cancelled";
  const edit = can(role, "onboarding.edit") && !locked;
  const ready = readiness.data?.ready ?? false;

  async function provision() {
    setConfirm(null);
    if (await act.run(() => api.onboarding.provision(app.id))) { toast.show("Business provisioned", "success"); reload(); }
    else reload();
  }
  async function cancel() {
    setConfirm(null);
    if (await act.run(() => api.onboarding.cancel(app.id))) { toast.show("Application cancelled", "success"); reload(); }
  }
  const statusOf = (key: string) => readiness.data?.items.find((i) => i.key === key)?.status ?? "pending";

  return (
    <div className="stack">
      <PageHeader title={app.business_name} description={`${app.source === "self_signup" ? "Self-signup" : "Assisted"} · agent ${name(app.agent_id)}${app.lead_id ? "" : " · walk-in"}`} actions={<><AppStatusBadge status={app.status} />
        {app.lead_id && <Link href={`/leads/${app.lead_id}`}><Button>Open lead</Button></Link>}
        {edit && <Link href={`/onboarding/${app.id}/wizard/owner`}><Button variant={ready ? "secondary" : "primary"}>{ready ? "Review wizard" : "Continue setup"}</Button></Link>}</>} />
      <FormError error={act.error} />
      {app.provisioning_error && <Notice tone="danger" title="Last provisioning attempt failed.">{app.provisioning_error}</Notice>}

      <Card as="section" aria-labelledby="rd">
        <div className="between"><h2 id="rd">Activation readiness</h2>
          {readiness.data && <Badge tone={ready ? "success" : "warning"}>{app.status === "provisioned" ? "Provisioned" : ready ? "Ready" : "Not ready"}</Badge>}</div>
        <AsyncView q={readiness} rows={2}>
          {(r) => app.status === "provisioned"
            ? <div style={{ marginTop: 12 }}><Notice tone="success">Provisioned on {fmtDateTime(app.provisioned_at)}. Business reference <span className="mono">{app.external_business_id}</span>. Commission entries are now pending approval in Earnings. Activation counts at the first real bill within 7 days.</Notice></div>
            : r.ready ? <div style={{ marginTop: 12 }}><Notice tone="success">All five items are done and the owner details are present.</Notice></div>
            : <div style={{ marginTop: 12 }}><Notice tone="warning" title="Still needed"><ul>{r.blockers.map((b) => <li key={b}>{blockerText(b)}</li>)}</ul></Notice></div>}
        </AsyncView>
        {edit && <div className="row" style={{ marginTop: 12 }}>
          <Button variant={ready ? "primary" : "secondary"} disabled={!ready || act.busy} onClick={() => setConfirm("provision")}>Provision business</Button>
          <Button variant="danger-soft" disabled={act.busy} onClick={() => setConfirm("cancel")}>Cancel application</Button>
        </div>}
      </Card>

      {app.external_business_id && <ActivationCard appId={app.id} canRefresh={can(role, "onboarding.edit")} />}

      <DocumentsCard appId={app.id} canEdit={edit} canDecide={role === "marketing_admin" && !locked} onChange={readiness.reload} />

      <Card as="section" aria-labelledby="ck">
        <h2 id="ck">Checklist</h2>
        <div role="list">
          {CHECKLIST_ORDER.map((key) => {
            const s = statusOf(key);
            return (
              <div key={key} role="listitem" className="check">
                <span className="grow"><span className="title">{CHECKLIST_LABEL[key]}</span></span>
                <Badge tone={s === "done" ? "success" : s === "in_progress" ? "info" : "neutral"}>{s === "done" ? "Done" : s === "in_progress" ? "In progress" : "To do"}</Badge>
                {edit && <Link href={`/onboarding/${app.id}/wizard/${key}`}><Button size="sm">{s === "done" ? "Review" : "Open"}</Button></Link>}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid two">
        <Card as="section" aria-labelledby="ow">
          <h2 id="ow">Owner</h2>
          <dl style={{ margin: "12px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px" }}>
            <dt className="muted">Name</dt><dd style={{ margin: 0 }}>{app.owner_name ?? "—"}</dd>
            <dt className="muted">Email</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{app.owner_email ?? "—"}</dd>
            <dt className="muted">Phone</dt><dd style={{ margin: 0 }}>{app.owner_phone ?? "—"}</dd>
            {role === "marketing_admin" && <><dt className="muted">Contract</dt><dd style={{ margin: 0 }}>{fmtMoney(app.contract_value_minor, app.currency)}</dd></>}
          </dl>
        </Card>
        {role === "marketing_admin" && !locked && (
          <Card as="section" aria-labelledby="adm">
            <h2 id="adm">Admin</h2>
            <div className="stack-sm" style={{ marginTop: 12 }}>
              <div className="row" style={{ alignItems: "end" }}>
                <div style={{ flex: 1, minWidth: 160 }}><Select label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">Unassigned</option>{users.filter((u) => u.role === "onboarding_agent").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></div>
                <Button disabled={act.busy || agent === (app.agent_id ?? "")} onClick={async () => { if (await act.run(() => api.onboarding.assign(app.id, agent || null))) { toast.show("Agent assigned", "success"); reload(); } }}>Save</Button>
              </div>
              <div className="row" style={{ alignItems: "end" }}>
                <div style={{ flex: 1, minWidth: 160 }}><Input label="Contract value" type="number" inputMode="decimal" min={0} value={contract} onChange={(e) => setContract(e.target.value)} /></div>
                <Button disabled={act.busy} onClick={async () => { if (await act.run(() => api.onboarding.update(app.id, { contract_value_minor: Math.round(Number(contract || 0) * 100) }))) { toast.show("Contract value saved", "success"); reload(); } }}>Save</Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      <Card as="section" aria-labelledby="iv">
        <div className="between"><h2 id="iv">Invitations</h2>{can(role, "invitation.create") && !locked && <Button onClick={() => setInviteOpen(true)}>Send invite</Button>}</div>
        <AsyncView q={invites} rows={1} isEmpty={(d) => d.length === 0} empty={{ title: "No invite sent", description: "Send the owner a link to set a password and accept the terms." }}>
          {(rows) => <ul className="list">{rows.map((i) => <li key={i.id}><span className="grow"><span className="title">{i.email}</span><br /><span className="small muted">sent {fmtDateTime(i.created_at)}</span></span><InvitationStatus inv={i} /></li>)}</ul>}
        </AsyncView>
      </Card>

      <Dialog open={confirm === "provision"} onOpenChange={(o) => !o && setConfirm(null)} title="Provision this business?" description="This creates the business on the Chilli Agent platform and locks the checklist."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Not yet</Button><Button variant="primary" onClick={provision}>Provision</Button></>} />
      <Dialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel this application?" description="You cannot undo this."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Keep it</Button><Button variant="danger-soft" onClick={cancel}>Cancel application</Button></>} />
      <InviteSheet key={inviteOpen ? "o" : "c"} open={inviteOpen} onOpenChange={setInviteOpen} leadId={app.lead_id} applicationId={app.id} defaultEmail={app.owner_email} onCreated={invites.reload} />
    </div>
  );
}
