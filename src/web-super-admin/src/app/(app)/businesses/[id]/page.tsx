"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge, Button, Card, Checkbox, Dialog, Select, Table, Textarea, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { BusinessType, Outlet, TenantDetail } from "@/lib/api/types";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { DefList, InlineError, PageHeader, ReasonDialog, ResourceView, StatusBadge } from "@/components/ui";
import { CreditPanel } from "@/components/CreditPanel";

type Act = "suspend" | "reactivate" | "close";
const COPY: Record<Act, { title: string; desc: (n: string) => string; confirm: string }> = {
  suspend: { title: "Suspend business", desc: (n) => `${n} will lose access to Chilli until it is reactivated. Entitlements switch off immediately.`, confirm: "Suspend" },
  reactivate: { title: "Reactivate business", desc: (n) => `${n} will get its plan features back.`, confirm: "Reactivate" },
  close: { title: "Close business", desc: (n) => `Closing ${n} cancels its subscription. This cannot be undone from this screen.`, confirm: "Close business" },
};

export default function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const toast = useToast();
  const res = useResource(async () => {
    const [t, sub] = await Promise.all([api.tenants.get(id), can("subscriptions.read") ? api.catalog.tenantSubscription(id) : Promise.resolve(null)]);
    const plans = sub ? await api.catalog.plans().then((p) => p.items).catch(() => []) : [];
    return { t, sub, plans };
  }, id);
  const [act, setAct] = useState<Act | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);

  const doAct = async (reason: string): Promise<ApiError | undefined> => {
    try { await api.tenants[act!](id, reason); toast.show(`${COPY[act!].confirm} done`, "success"); res.reload(); } catch (e) { return e as ApiError; }
  };

  return (
    <ResourceView res={res} empty={{ title: "Not found" }} isEmpty={() => false}>
      {({ t, sub, plans }) => (
        <>
          <p><Link className="hq-link" href="/businesses">Back to businesses</Link></p>
          <PageHeader title={t.display_name} subtitle={`${t.slug} · created ${fmtDate(t.created_at)}`} actions={<>
            <StatusBadge value={t.status} />
            {can("entitlements.read") ? <Link className="ch-btn ch-btn--secondary ch-btn--md" href={`/platform/entitlements?tenant=${t.slug}`}>Entitlements</Link> : null}
            {can("tenants.suspend") && t.status === "suspended" ? <Button variant="primary" onClick={() => setAct("reactivate")}>Reactivate</Button> : null}
            {can("tenants.suspend") && t.status === "active" ? <Button variant="danger-soft" onClick={() => setAct("suspend")}>Suspend</Button> : null}
            {can("tenants.suspend") && t.status !== "closed" ? <Button variant="danger-soft" onClick={() => setAct("close")}>Close</Button> : null}
          </>} />
          {t.status_reason ? <p className="hq-sub" style={{ marginBottom: 16 }}>Status reason: {t.status_reason} ({fmtDateTime(t.status_changed_at)})</p> : null}
          <div className="hq-grid-2">
            <Card as="section">
              <h2 className="hq-card-title">Business profile</h2>
              <Profile t={t} />
              <p style={{ marginTop: 12 }}>
                <span className="hq-muted">Business types: </span>
                {(t.business_types ?? ["restaurant"]).map((b) => BUSINESS_TYPE_LABEL[b]).join(", ")}
                {can("tenants.write") && t.status !== "closed" ? <Button size="sm" style={{ marginLeft: 8 }} onClick={() => setTypesOpen(true)}>Change</Button> : null}
              </p>
            </Card>
            <Card as="section">
              <h2 className="hq-card-title">Subscription</h2>
              {sub ? (
                sub.current ? (
                  <DefList items={[["Plan", plans.find((p) => p.id === sub.current!.plan_id)?.name ?? "–"], ["Status", <StatusBadge key="s" value={sub.current.status} />], ["Period ends", fmtDate(sub.current.current_period_end)], ["Trial ends", fmtDate(sub.current.trial_end)], ["Cancels at period end", sub.current.cancel_at_period_end ? "Yes" : "No"]]} />
                ) : <p className="hq-muted">No live subscription.</p>
              ) : <p className="hq-muted">Your role cannot see subscriptions.</p>}
              {can("subscriptions.manage") && t.status !== "closed" ? <p><Button size="sm" onClick={() => setPlanOpen(true)}>{sub?.current ? "Change plan" : "Assign plan"}</Button></p> : null}
            </Card>
          </div>
          {can("wallet.read") ? <div style={{ marginTop: 16 }}><CreditPanel tenantRef={t.slug} tenantName={t.display_name} /></div> : null}
          <h2 className="hq-h2">Outlets</h2>
          <Table<Outlet> caption="Outlets" getKey={(o) => o.id} rows={t.outlets} empty={<p className="hq-muted">No outlets registered yet.</p>} columns={[
            { key: "n", header: "Outlet", render: (o) => o.name }, { key: "c", header: "Code", render: (o) => o.code ?? "–" }, { key: "ci", header: "City", render: (o) => o.city ?? "–" },
            { key: "s", header: "Status", render: (o) => <StatusBadge value={o.status} /> },
          ]} />
          {act ? <ReasonDialog open onOpenChange={(o) => !o && setAct(null)} title={COPY[act].title} description={COPY[act].desc(t.display_name)} confirmLabel={COPY[act].confirm} onConfirm={doAct} /> : null}
          {planOpen ? <PlanDialog plans={plans} current={sub?.current?.plan_id} onClose={() => setPlanOpen(false)} onDone={() => { setPlanOpen(false); toast.show("Plan updated", "success"); res.reload(); }} tenantRef={id} /> : null}
          {typesOpen ? <BusinessTypesDialog current={t.business_types ?? ["restaurant"]} tenantRef={id} businessName={t.display_name} onClose={() => setTypesOpen(false)}
            onDone={(posSync) => { setTypesOpen(false); toast.show(posSync === "synced" || posSync === undefined ? "Business types updated" : `Business types updated (pos sync: ${posSync}; it will retry)`, posSync?.startsWith("failed") ? "danger" : "success"); res.reload(); }} /> : null}
        </>
      )}
    </ResourceView>
  );
}

const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = { restaurant: "Restaurant", cloud_kitchen: "Cloud kitchen", hotel_kitchen: "Hotel kitchen" };
const ALL_BUSINESS_TYPES: BusinessType[] = ["restaurant", "cloud_kitchen", "hotel_kitchen"];

/** The owner's own change is locked (403 business_type_locked, docs/BUSINESS_TYPES.md): only here, Super Admin, staff-only. */
function BusinessTypesDialog({ current, tenantRef, businessName, onClose, onDone }: {
  current: BusinessType[]; tenantRef: string; businessName: string; onClose: () => void; onDone: (posSync?: string) => void;
}) {
  const [picked, setPicked] = useState<BusinessType[]>(current);
  const [reason, setReason] = useState("");
  const toggle = (b: BusinessType) => setPicked((p) => (p.includes(b) ? p.filter((x) => x !== b) : [...p, b]));
  const { run, busy, error } = useAction(async () => {
    const out = await api.tenants.setBusinessTypes(tenantRef, picked, reason.trim() || undefined);
    onDone(out.pos_sync);
  });
  const unchanged = picked.length === current.length && picked.every((b) => current.includes(b));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Change business types" description={`What ${businessName} operates as. One or more. Removing a type never deletes data, it only turns off its features (e.g. tables, dine-in).`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={picked.length === 0 || unchanged} onClick={() => void run()}>Save</Button></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ALL_BUSINESS_TYPES.map((b) => (
          <Checkbox key={b} label={BUSINESS_TYPE_LABEL[b]} checked={picked.includes(b)} onChange={() => toggle(b)} />
        ))}
      </div>
      <Textarea label="Reason (optional, kept in the audit log)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      <InlineError error={error} />
      <Badge tone="neutral">Recorded in the audit log</Badge>
    </Dialog>
  );
}

function Profile({ t }: { t: TenantDetail }) {
  const p = t.profile;
  if (!p) return <p className="hq-muted">No profile on file.</p>;
  return <DefList items={[["Legal name", p.legal_name], ["GSTIN", p.gstin && <span key="g" className="hq-mono">{p.gstin}</span>], ["PAN", p.pan], ["FSSAI", p.fssai], ["State code", p.state_code], ["City", p.city], ["Contact", p.contact_name], ["Email", p.contact_email], ["Phone", p.contact_phone]]} />;
}

function PlanDialog({ plans, current, tenantRef, onClose, onDone }: { plans: { id: string; code: string; name: string }[]; current?: string; tenantRef: string; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(plans.find((p) => p.id !== current)?.code ?? plans[0]?.code ?? "");
  const { run, busy, error } = useAction(async () => { await api.catalog.assignPlan(tenantRef, { plan_code: code, reason: "Changed from HQ" }); onDone(); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Change plan" description="The current subscription ends and the new plan starts now. Entitlements update immediately."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!code} onClick={() => void run()}>Change plan</Button></>}>
      <Select label="Plan" value={code} onChange={(e) => setCode(e.target.value)}>{plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select>
      <InlineError error={error} />
      <Badge tone="neutral">Recorded in the audit log</Badge>
    </Dialog>
  );
}
