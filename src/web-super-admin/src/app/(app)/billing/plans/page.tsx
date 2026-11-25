"use client";
import { useState } from "react";
import { Badge, Button, Card, Dialog, Money, useToast } from "@chilli/ui";
import { ApiError, api } from "@/lib/api";
import type { Plan } from "@/lib/api/types";
import { fmtDateTime, fmtLimit } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useResource } from "@/lib/useResource";
import { PlanEditor } from "@/components/PlanEditor";
import { PageHeader, ReasonDialog, ResourceView, StatusBadge } from "@/components/ui";

export default function PlansPage() {
  const can = useCan();
  const toast = useToast();
  const manage = can("catalog.manage");
  const res = useResource(async () => {
    const [plans, features] = await Promise.all([api.catalog.plans(), api.catalog.features()]);
    return { plans: plans.items, features: features.items };
  }, "plans");
  const [dlg, setDlg] = useState<null | { kind: "new" } | { kind: "edit" | "retire" | "reactivate" | "history"; p: Plan }>(null);
  const attempt = async (fn: () => Promise<unknown>, msg: string): Promise<ApiError | undefined> => {
    try { await fn(); toast.show(msg, "success"); res.reload(); return undefined; } catch (e) { return e instanceof ApiError ? e : new ApiError(0, "unknown", "Something went wrong"); }
  };
  const saved = (msg: string) => { setDlg(null); toast.show(msg, "success"); res.reload(); };
  return (
    <>
      <PageHeader title="Plans" subtitle="Prices exclude GST. Every change is versioned and audited; plans are retired, never deleted." actions={manage ? <Button variant="primary" onClick={() => setDlg({ kind: "new" })}>New plan</Button> : undefined} />
      <ResourceView res={res} isEmpty={(d) => d.plans.length === 0} empty={{ title: "No plans defined", description: manage ? "Create the first plan." : "Plans are created by the platform team.", actionLabel: manage ? "New plan" : undefined, onAction: manage ? () => setDlg({ kind: "new" }) : undefined }}>
        {(d) => (
          <>
            <div className="hq-grid">
              {d.plans.map((p) => (
                <Card as="section" key={p.id}>
                  <h2 className="hq-card-title">{p.name} {!p.is_active ? <Badge>Retired</Badge> : null} <small className="hq-muted">v{p.version}</small></h2>
                  <p className="hq-kpi__v"><Money value={p.price_paise} /><small className="hq-muted"> / {p.billing_period}</small></p>
                  <p className="hq-sub">{p.description}</p>
                  <p className="hq-sub">{p.live_subscriptions ?? 0} live {p.live_subscriptions === 1 ? "subscription" : "subscriptions"}</p>
                  <ul>
                    {p.features.filter((f) => f.enabled).map((f) => {
                      const meta = d.features.find((x) => x.code === f.feature_code);
                      return <li key={f.feature_code}>{meta?.name ?? f.feature_code}{f.limit_value !== null ? `: ${fmtLimit(f.limit_value, meta?.unit)}` : meta?.kind === "limit" ? ": unlimited" : ""}</li>;
                    })}
                  </ul>
                  <div className="hq-row">
                    <Button size="sm" onClick={() => setDlg({ kind: "history", p })}>History</Button>
                    {manage ? <Button size="sm" onClick={() => setDlg({ kind: "edit", p })}>Edit</Button> : null}
                    {manage ? (p.is_active ? <Button size="sm" onClick={() => setDlg({ kind: "retire", p })}>Retire</Button> : <Button size="sm" onClick={() => setDlg({ kind: "reactivate", p })}>Reactivate</Button>) : null}
                  </div>
                </Card>
              ))}
            </div>
            {dlg?.kind === "new" ? <PlanEditor features={d.features} onClose={() => setDlg(null)} onDone={(p) => saved(`Plan ${p.name} created`)} /> : null}
            {dlg?.kind === "edit" ? <PlanEditor plan={dlg.p} features={d.features} onClose={() => setDlg(null)} onDone={(p) => saved(`${p.name} saved as version ${p.version}`)} /> : null}
            {dlg?.kind === "retire" ? <ReasonDialog open onOpenChange={(o) => !o && setDlg(null)} title={`Retire ${dlg.p.name}?`} description={`No new business can be put on it. The ${dlg.p.live_subscriptions ?? 0} that already use it keep it.`} confirmLabel="Retire plan"
              onConfirm={(reason) => attempt(() => api.catalog.retirePlan(dlg.p.code, reason), `${dlg.p.name} retired`)} /> : null}
            {dlg?.kind === "reactivate" ? <ReasonDialog open onOpenChange={(o) => !o && setDlg(null)} title={`Reactivate ${dlg.p.name}?`} description="It can be assigned to businesses again." confirmLabel="Reactivate"
              onConfirm={(reason) => attempt(() => api.catalog.reactivatePlan(dlg.p.code, reason), `${dlg.p.name} reactivated`)} /> : null}
            {dlg?.kind === "history" ? <History p={dlg.p} onClose={() => setDlg(null)} /> : null}
          </>
        )}
      </ResourceView>
    </>
  );
}

function History({ p, onClose }: { p: Plan; onClose: () => void }) {
  const res = useResource(() => api.catalog.planVersions(p.code), `pv-${p.code}-${p.version}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${p.name}: version history`} description="Newest first. Each entry is a full snapshot.">
      <ResourceView res={res} empty={{ title: "No history" }}>
        {(d) => <ol className="hq-stack" style={{ paddingLeft: 18 }}>{d.items.map((v) => (
          <li key={v.version}><strong>v{v.version}</strong> <StatusBadge value={v.change} /> <span className="hq-muted">{v.actor}, {fmtDateTime(v.at)}</span><br />
            <Money value={v.snapshot.price_paise} /> / {v.snapshot.billing_period}, {v.snapshot.features.filter((f) => f.enabled).length} features{v.note ? <> &middot; {v.note}</> : null}</li>
        ))}</ol>}
      </ResourceView>
    </Dialog>
  );
}
